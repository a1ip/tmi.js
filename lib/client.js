var api = require("./api");
var commands = require("./commands");
var eventEmitter = require("./events").EventEmitter;
var logger = require("./logger");
var parse = require("./parser");
var timer = require("./timer");
var extraUtils = require('./extra-utils');
var ws = global.WebSocket || global.MozWebSocket || require("ws");
var _ = require("./utils");

// Client instance..
var client = function client(opts) {
    if (this instanceof client === false) { return new client(opts); }
    this.setMaxListeners(0);

    this.opts = _.get(opts, {});
    this.opts.channels = this.opts.channels || [];
    this.opts.connection = this.opts.connection || {};
    this.opts.identity = this.opts.identity || {};
    this.opts.options = this.opts.options || {};

    this.clientId = _.get(this.opts.options.clientId, null);

    this.maxReconnectAttempts = _.get(this.opts.connection.maxReconnectAttempts, Infinity);
    this.maxReconnectInterval = _.get(this.opts.connection.maxReconnectInterval, 30000);
    this.reconnect = _.get(this.opts.connection.reconnect, false);
    this.reconnectDecay = _.get(this.opts.connection.reconnectDecay, 1.5);
    this.reconnectInterval = _.get(this.opts.connection.reconnectInterval, 1000);

    this.reconnecting = false;
    this.reconnections = 0;
    this.reconnectTimer = this.reconnectInterval;

    this.secure = _.get(this.opts.connection.secure, false);

    // Raw data and object for emote-sets..
    this.emotes = "";
    this.emotesets = {};

    this.channels = [];
    this.currentLatency = 0;
    this.globaluserstate = {};
    this.lastJoined = "";
    this.latency = new Date();
    this.moderators = {};
    this.pingLoop = null;
    this.pingTimeout = null;
    this.reason = "";
    this.username = "";
    this.userstate = {};
    this.wasCloseCalled = false;
    this.ws = null;

    // Create the logger..
    var level = "error";
    if (this.opts.options.debug) { level = "info"; }
    this.log = this.opts.logger || logger;

    try { logger.setLevel(level); } catch(e) {};

    // Format the channel names..
    this.opts.channels.forEach(function(part, index, theArray) {
        theArray[index] = _.channel(part);
    });

    eventEmitter.call(this);
}

_.inherits(client, eventEmitter);

client.prototype.api = api;

// Put all commands in prototype..
for(var methodName in commands) {
    client.prototype[methodName] = commands[methodName];
}

// Handle parsed chat server message..
client.prototype.handleMessage = function handleMessage(message) {
    if (_.isNull(message)) {
        return;
    }

    this.emit("raw_message", Object.assign({}, message), message);

    var channel = _.channel(_.get(message.params[0], null));
    var msg = _.get(message.params[1], null);
    var msgid = _.get(message.tags["msg-id"], null);

    // Parse badges and emotes..
    message.tags = parse.badges(parse.emotes(message.tags));

    // Transform IRCv3 tags..
    if (message.tags) {
        for(var key in message.tags) {
            if (key !== "emote-sets" && key !== "ban-duration" && key !== "bits") {
                if (_.isBoolean(message.tags[key])) { message.tags[key] = null; }
                else if (message.tags[key] === "1") { message.tags[key] = true; }
                else if (message.tags[key] === "0") { message.tags[key] = false; }
            }
        }
    }

    // Messages with no prefix..
    if (_.isNull(message.prefix)) {
        switch(message.command) {
            // Received PING from server..
            case "PING":
                this.emit("ping");
                if (!_.isNull(this.ws) && this.ws.readyState !== 2 && this.ws.readyState !== 3) {
                    this.ws.send("PONG");
                }
                break;

            // Received PONG from server, return current latency..
            case "PONG":
                var currDate = new Date();
                this.currentLatency = (currDate.getTime() - this.latency.getTime()) / 1000;
                this.emits(["pong", "_promisePing"], [[this.currentLatency]]);

                clearTimeout(this.pingTimeout);
                break;

            default:
                this.log.warn(`Could not parse message with no prefix:\n${JSON.stringify(message, null, 4)}`);
                break;
        }
    }

    // Messages with "tmi.twitch.tv" as a prefix..
    else if (message.prefix === "tmi.twitch.tv") {
        switch(message.command) {
            case "002":
            case "003":
            case "004":
            case "375":
            case "376":
            case "CAP":
                break;

            // Retrieve username from server..
            case "001":
                this.username = message.params[0];
                break;

            // Connected to server..
            case "372":
                this.log.info("Connected to server.");
                this.userstate["#tmijs"] = {};
                this.emits(["connected", "_promiseConnect"], [[this.server, this.port], [null]]);
                this.reconnections = 0;
                this.reconnectTimer = this.reconnectInterval;

                // Set an internal ping timeout check interval..
                this.pingLoop = setInterval(() => {
                    // Make sure the connection is opened before sending the message..
                    if (!_.isNull(this.ws) && this.ws.readyState !== 2 && this.ws.readyState !== 3) {
                        this.ws.send("PING");
                    }
                    this.latency = new Date();
                    this.pingTimeout = setTimeout(() => {
                        if (!_.isNull(this.ws)) {
                            this.wasCloseCalled = false;
                            this.log.error("Ping timeout.");
                            this.ws.close();

                            clearInterval(this.pingLoop);
                            clearTimeout(this.pingTimeout);
                        }
                    }, _.get(this.opts.connection.timeout, 9999));
                }, 60000);

                // Join all the channels from configuration with a 2 seconds interval..
                var joinQueue = new timer.queue(2000);
                var joinChannels = _.union(this.opts.channels, this.channels);
                this.channels = [];

                for (var i = 0; i < joinChannels.length; i++) {
                    var self = this;
                    joinQueue.add(function(i) {
                        if (!_.isNull(self.ws) && self.ws.readyState !== 2 && self.ws.readyState !== 3) {
                            self.ws.send(`JOIN ${_.channel(joinChannels[i])}`);
                        }
                    }.bind(this, i))
                }

                joinQueue.run();
                break;

            // https://github.com/justintv/Twitch-API/blob/master/chat/capabilities.md#notice
            case "NOTICE":
                var nullArr = [null];
                var noticeArr = [channel, msgid, msg];
                var msgidArr = [msgid];
                var channelTrueArr = [channel, true];
                var channelFalseArr = [channel, false];
                var noticeAndNull = [noticeArr, nullArr];
                var noticeAndMsgid = [noticeArr, msgidArr];
                switch(msgid) {
                    // This room is now in subscribers-only mode.
                    case "subs_on":
                        this.log.info(`[${channel}] This room is now in subscribers-only mode.`);
                        this.emits(["subscriber", "subscribers", "_promiseSubscribers"], [channelTrueArr, channelTrueArr, nullArr]);
                        break;

                    // This room is no longer in subscribers-only mode.
                    case "subs_off":
                        this.log.info(`[${channel}] This room is no longer in subscribers-only mode.`);
                        this.emits(["subscriber", "subscribers", "_promiseSubscribersoff"], [channelFalseArr, channelFalseArr, nullArr]);
                        break;

                    // This room is now in emote-only mode.
                    case "emote_only_on":
                        this.log.info(`[${channel}] This room is now in emote-only mode.`);
                        this.emits(["emoteonly", "_promiseEmoteonly"], [channelTrueArr, nullArr]);
                        break;

                    // This room is no longer in emote-only mode.
                    case "emote_only_off":
                        this.log.info(`[${channel}] This room is no longer in emote-only mode.`);
                        this.emits(["emoteonly", "_promiseEmoteonlyoff"], [channelFalseArr, nullArr]);
                        break;

                    // Do not handle slow_on/off here, listen to the ROOMSTATE notice instead as it returns the delay.
                    case "slow_on":
                    case "slow_off":
                        break;

                    // Do not handle followers_on/off here, listen to the ROOMSTATE notice instead as it returns the delay.
                    case "followers_on_zero":
                    case "followers_on":
                    case "followers_off":
                        break;

                    // This room is now in r9k mode.
                    case "r9k_on":
                        this.log.info(`[${channel}] This room is now in r9k mode.`);
                        this.emits(["r9kmode", "r9kbeta", "_promiseR9kbeta"], [channelTrueArr, channelTrueArr, nullArr]);
                        break;

                    // This room is no longer in r9k mode.
                    case "r9k_off":
                        this.log.info(`[${channel}] This room is no longer in r9k mode.`);
                        this.emits(["r9kmode", "r9kbeta", "_promiseR9kbetaoff"], [channelFalseArr, channelFalseArr, nullArr]);
                        break;

                    // The moderators of this room are [...]
                    case "room_mods":
                        var mods = msg.split(': ')[1].toLowerCase()
                            .split(', ')
                            .filter(n => n);

                        this.emits(["_promiseMods", "mods"], [[null, mods], [channel, mods]]);
                        break;

                    // There are no moderators for this room.
                    case "no_mods":
                        this.emit("_promiseMods", null, []);
                        break;

                    // Channel is suspended..
                    case "msg_channel_suspended":
                        this.emits(["notice", "_promiseJoin"], noticeAndMsgid);
                        break;

                    // Ban command failed..
                    case "already_banned":
                    case "bad_ban_admin":
                    case "bad_ban_broadcaster":
                    case "bad_ban_global_mod":
                    case "bad_ban_self":
                    case "bad_ban_staff":
                    case "usage_ban":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseBan"], noticeAndMsgid);
                        break;

                    // Ban command success..
                    case "ban_success":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseBan"], noticeAndNull);
                        break;

                    // Clear command failed..
                    case "usage_clear":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseClear"], noticeAndMsgid);
                        break;

                    // Mods command failed..
                    case "usage_mods":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseMods"], [noticeArr, [msgid, []]]);
                        break;

                    // Mod command success..
                    case "mod_success":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseMod"], noticeAndNull);
                        break;

                    // Mod command failed..
                    case "usage_mod":
                    case "bad_mod_banned":
                    case "bad_mod_mod":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseMod"], noticeAndMsgid);
                        break;

                    // Unmod command success..
                    case "unmod_success":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseUnmod"], noticeAndNull);
                        break;

                    // Unmod command failed..
                    case "usage_unmod":
                    case "bad_unmod_mod":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseUnmod"], noticeAndMsgid);
                        break;

                    // Color command success..
                    case "color_changed":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseColor"], noticeAndNull);
                        break;

                    // Color command failed..
                    case "usage_color":
                    case "turbo_only_color":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseColor"], noticeAndMsgid);
                        break;

                    // Commercial command success..
                    case "commercial_success":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseCommercial"], noticeAndNull);
                        break;

                    // Commercial command failed..
                    case "usage_commercial":
                    case "bad_commercial_error":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseCommercial"], noticeAndMsgid);
                        break;

                    // Host command success..
                    case "hosts_remaining":
                        this.log.info(`[${channel}] ${msg}`);
                        var remainingHost = (!isNaN(msg[0]) ? parseInt(msg[0]) : 0);
                        this.emits(["notice", "_promiseHost"], [noticeArr, [null, ~~remainingHost]]);
                        break;

                    // Host command failed..
                    case "bad_host_hosting":
                    case "bad_host_rate_exceeded":
                    case "bad_host_error":
                    case "usage_host":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseHost"], [noticeArr, [msgid, null]]);
                        break;

                    // r9kbeta command failed..
                    case "already_r9k_on":
                    case "usage_r9k_on":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseR9kbeta"], noticeAndMsgid);
                        break;

                    // r9kbetaoff command failed..
                    case "already_r9k_off":
                    case "usage_r9k_off":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseR9kbetaoff"], noticeAndMsgid);
                        break;

                    // Timeout command success..
                    case "timeout_success":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseTimeout"], noticeAndNull);
                        break;

                    case "delete_message_success":
                        this.log.info(`[${channel} ${msg}]`);
                        this.emits(["notice", "_promiseDeletemessage"], noticeAndNull);

                    // Subscribersoff command failed..
                    case "already_subs_off":
                    case "usage_subs_off":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseSubscribersoff"], noticeAndMsgid);
                        break;

                    // Subscribers command failed..
                    case "already_subs_on":
                    case "usage_subs_on":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseSubscribers"], noticeAndMsgid);
                        break;

                    // Emoteonlyoff command failed..
                    case "already_emote_only_off":
                    case "usage_emote_only_off":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseEmoteonlyoff"], noticeAndMsgid);
                        break;

                    // Emoteonly command failed..
                    case "already_emote_only_on":
                    case "usage_emote_only_on":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseEmoteonly"], noticeAndMsgid);
                        break;

                    // Slow command failed..
                    case "usage_slow_on":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseSlow"], noticeAndMsgid);
                        break;

                    // Slowoff command failed..
                    case "usage_slow_off":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseSlowoff"], noticeAndMsgid);
                        break;

                    // Timeout command failed..
                    case "usage_timeout":
                    case "bad_timeout_admin":
                    case "bad_timeout_broadcaster":
                    case "bad_timeout_duration":
                    case "bad_timeout_global_mod":
                    case "bad_timeout_self":
                    case "bad_timeout_staff":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseTimeout"], noticeAndMsgid);
                        break;

                    // Unban command success..
                    // Unban can also be used to cancel an active timeout.
                    case "untimeout_success":
                    case "unban_success":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseUnban"], noticeAndNull);
                        break;

                    // Unban command failed..
                    case "usage_unban":
                    case "bad_unban_no_ban":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseUnban"], noticeAndMsgid);
                        break;

                    // Delete command failed..
                    case "usage_delete":
                    case "bad_delete_message_error":
                    case "bad_delete_message_broadcaster":
                    case "bad_delete_message_mod":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseDeletemessage"], noticeAndMsgid);
                        break;

                    // Unhost command failed..
                    case "usage_unhost":
                    case "not_hosting":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseUnhost"], noticeAndMsgid);
                        break;

                    // Whisper command failed..
                    case "whisper_invalid_login":
                    case "whisper_invalid_self":
                    case "whisper_limit_per_min":
                    case "whisper_limit_per_sec":
                    case "whisper_restricted_recipient":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits(["notice", "_promiseWhisper"], noticeAndMsgid);
                        break;

                    // Permission error..
                    case "no_permission":
                    case "msg_banned":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emits([
                            "notice",
                            "_promiseBan",
                            "_promiseClear",
                            "_promiseUnban",
                            "_promiseTimeout",
                            "_promiseMods",
                            "_promiseMod",
                            "_promiseUnmod",
                            "_promiseCommercial",
                            "_promiseHost",
                            "_promiseUnhost",
                            "_promiseR9kbeta",
                            "_promiseR9kbetaoff",
                            "_promiseSlow",
                            "_promiseSlowoff",
                            "_promiseFollowers",
                            "_promiseFollowersoff",
                            "_promiseSubscribers",
                            "_promiseSubscribersoff",
                            "_promiseEmoteonly",
                            "_promiseEmoteonlyoff",
                            "_promiseDeletedmessage"
                        ], [ noticeArr, msgidArr ]);
                        break;

                    // Unrecognized command..
                    case "unrecognized_cmd":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emit("notice", channel, msgid, msg);

                        if (msg.split(" ").splice(-1)[0] === "/w") {
                            this.log.warn("You must be connected to a group server to send or receive whispers.");
                        }
                        break;

                    // Send the following msg-ids to the notice event listener..
                    case "cmds_available":
                    case "host_target_went_offline":
                    case "msg_censored_broadcaster":
                    case "msg_duplicate":
                    case "msg_emoteonly":
                    case "msg_verified_email":
                    case "msg_ratelimit":
                    case "msg_subsonly":
                    case "msg_timedout":
                    case "msg_bad_characters":
                    case "msg_channel_blocked":
                    case "msg_facebook":
                    case "msg_followersonly":
                    case "msg_followersonly_followed":
                    case "msg_followersonly_zero":
                    case "msg_rejected":
                    case "msg_slowmode":
                    case "msg_suspended":
                    case "no_help":
                    case "usage_disconnect":
                    case "usage_help":
                    case "usage_me":
                        this.log.info(`[${channel}] ${msg}`);
                        this.emit("notice", channel, msgid, msg);
                        break;

                    // Ignore this because we are already listening to HOSTTARGET..
                    case "host_on":
                    case "host_off":
                        //
                        break;

                    default:
                        if (msg.includes("Login unsuccessful") || msg.includes("Login authentication failed")) {
                            this.wasCloseCalled = false;
                            this.reconnect = false;
                            this.reason = msg;
                            this.log.error(this.reason);
                            this.ws.close();
                        }
                        else if (msg.includes("Error logging in") || msg.includes("Improperly formatted auth")) {
                            this.wasCloseCalled = false;
                            this.reconnect = false;
                            this.reason = msg;
                            this.log.error(this.reason);
                            this.ws.close();
                        }
                        else if (msg.includes("Invalid NICK")) {
                            this.wasCloseCalled = false;
                            this.reconnect = false;
                            this.reason = "Invalid NICK.";
                            this.log.error(this.reason);
                            this.ws.close();
                        }
                        else {
                            this.log.warn(`Could not parse NOTICE from tmi.twitch.tv:\n${JSON.stringify(message, null, 4)}`);
                        }
                        break;
                }
                break;

            // Handle subanniversary / resub..
            case "USERNOTICE":
                var username = message.tags["display-name"] || message.tags["login"];
                var plan = message.tags["msg-param-sub-plan"] || "";
                var planName = _.unescapeIRC(_.get(message.tags["msg-param-sub-plan-name"], "")) || null;
                var prime = plan.includes("Prime");
                var userstate = message.tags;
                var months = _.get(~~message.tags["msg-param-months"], null);
                var recipient = message.tags["msg-param-recipient-display-name"] || message.tags["msg-param-recipient-user-name"];
                var numbOfSubs = message.tags["msg-param-mass-gift-count"];
                userstate["message-type"] = msgid;

                if (msgid === "resub") {
                    this.emits(["resub", "subanniversary"], [
                        [channel, username, months, msg, userstate, {prime, plan, planName}]
                    ]);
                }

                // Handle sub
                else if (msgid == "sub") {
                    this.emit("subscription", channel, username, {prime, plan, planName}, msg, userstate);
                }

                // Handle gift sub
                else if (msgid == "subgift") {
                    this.emit("subgift", channel, username, months, recipient, {plan, planName}, userstate);
                }

                // Handle anonymous gift sub
                else if (msgid == "anonsubgift") {
                    this.emit("anonsubgift", channel, months, recipient, {plan, planName}, userstate);
                }

                // Handle random gift subs
                else if (msgid == "submysterygift") {
                    this.emit("submysterygift", channel, username, numbOfSubs, {plan, planName}, userstate);
                }

                // Handle anonymous random gift subs
                else if (msgid == "anonsubmysterygift") {
                    this.emit("anonsubmysterygift", channel, numbOfSubs, {plan, planName}, userstate);
                }

                // Handle user upgrading from a gifted sub
                else if (msgid == "giftpaidupgrade") {
                    var sender = message.tags["msg-param-sender-name"] || message.tags["msg-param-sender-login"];

                    this.emit("giftpaidupgrade", channel, username, sender, userstate);
                }

                // Handle user upgrading from an anonymous gifted sub
                else if (msgid == "anongiftpaidupgrade") {
                    this.emit("anongiftpaidupgrade", channel, username, userstate);
                }

                // Handle raid
                else if (msgid == "raid") {
                    var username = message.tags["msg-param-displayName"] || message.tags["msg-param-login"];
                    var viewers = message.tags["msg-param-viewerCount"];

                    this.emit("raided", channel, username, viewers);
                }

                break;

            // Channel is now hosting another channel or exited host mode..
            case "HOSTTARGET":
                var msgSplit = msg.split(" ");
                // Stopped hosting..
                if (msgSplit[0] === "-") {
                    this.log.info(`[${channel}] Exited host mode.`);
                    this.emits(["unhost", "_promiseUnhost"], [[channel, ~~msgSplit[1] || 0], [null]]);
                }
                // Now hosting..
                else {
                    var viewers = ~~msgSplit[1] || 0;

                    this.log.info(`[${channel}] Now hosting ${msgSplit[0]} for ${viewers} viewer(s).`);
                    this.emit("hosting", channel, msgSplit[0], viewers);
                }
                break;

            // Someone has been timed out or chat has been cleared by a moderator..
            case "CLEARCHAT":
                // User has been banned / timed out by a moderator..
                if (message.params.length > 1) {
                    // Duration returns null if it's a ban, otherwise it's a timeout..
                    var duration = _.get(message.tags["ban-duration"], null);

                    var reason = _.unescapeIRC(_.get(message.tags["ban-reason"], "")) || null;

                    if (_.isNull(duration)) {
                        this.log.info(`[${channel}] ${msg} has been banned. Reason: ${reason || "n/a"}`);
                        this.emit("ban", channel, msg, reason);
                    } else {
                        this.log.info(`[${channel}] ${msg} has been timed out for ${duration} seconds. Reason: ${reason || "n/a"}`);
                        this.emit("timeout", channel, msg, reason, ~~duration);
                    }
                }
                // Chat was cleared by a moderator..
                else {
                    this.log.info(`[${channel}] Chat was cleared by a moderator.`);
                    this.emits(["clearchat", "_promiseClear"], [[channel], [null]]);
                }
                break;

            // Someone's message has been deleted
            case "CLEARMSG":
                if (message.params.length > 1) {
                    var username = message.tags["login"];
                    var deletedMessage = message.tags["message"];

                    var userstate = message.tags;
                    userstate["message-type"] = "messageremoved";

                    this.log.info(`[${channel}] ${username}'s message has been removed.`);
                    this.emit("messageremoved", channel, username, deletedMessage, userstate);
                }
                break;

            // Received a reconnection request from the server..
            case "RECONNECT":
                this.log.info("Received RECONNECT request from Twitch..");
                this.log.info(`Disconnecting and reconnecting in ${Math.round(this.reconnectTimer / 1000)} seconds..`);
                this.disconnect();
                setTimeout(() => { this.connect(); }, this.reconnectTimer);
                break;

            // Wrong cluster..
            case "SERVERCHANGE":
                //
                break;

            // Received when joining a channel and every time you send a PRIVMSG to a channel.
            case "USERSTATE":
                message.tags.username = this.username;

                // Add the client to the moderators of this room..
                if (message.tags["user-type"] === "mod") {
                    if (!this.moderators[this.lastJoined]) { this.moderators[this.lastJoined] = []; }
                    if (!this.moderators[this.lastJoined].includes(this.username)) { this.moderators[this.lastJoined].push(this.username); }
                }

                // Logged in and username doesn't start with justinfan..
                if (!_.isJustinfan(this.getUsername()) && !this.userstate[channel]) {
                    this.userstate[channel] = message.tags;
                    this.lastJoined = channel;
                    this.channels.push(channel);
                    this.log.info(`Joined ${channel}`);
                    this.emit("join", channel, _.username(this.getUsername()), true);
                }

                // Emote-sets has changed, update it..
                if (message.tags["emote-sets"] !== this.emotes) {
                    this._updateEmoteset(message.tags["emote-sets"]);
                }

                this.userstate[channel] = message.tags;
                break;

            // Describe non-channel-specific state informations..
            case "GLOBALUSERSTATE":
                this.globaluserstate = message.tags;

                // Received emote-sets..
                if (typeof message.tags["emote-sets"] !== "undefined") {
                    this._updateEmoteset(message.tags["emote-sets"]);
                }
                break;

            // Received when joining a channel and every time one of the chat room settings, like slow mode, change.
            // The message on join contains all room settings.
            case "ROOMSTATE":
                // We use this notice to know if we successfully joined a channel..
                if (_.channel(this.lastJoined) === _.channel(message.params[0])) { this.emit("_promiseJoin", null); }

                // Provide the channel name in the tags before emitting it..
                message.tags.channel = _.channel(message.params[0]);
                this.emit("roomstate", _.channel(message.params[0]), message.tags);

                // Handle slow mode here instead of the slow_on/off notice..
                // This room is now in slow mode. You may send messages every slow_duration seconds.
                if (message.tags.hasOwnProperty("slow") && !message.tags.hasOwnProperty("subs-only")) {
                    if (typeof message.tags.slow === "boolean") {
                        this.log.info(`[${channel}] This room is no longer in slow mode.`);
                        this.emits(["slow", "slowmode", "_promiseSlowoff"], [[channel, false, 0], [channel, false, 0], [null]]);
                    } else {
                        this.log.info(`[${channel}] This room is now in slow mode.`);
                        this.emits(["slow", "slowmode", "_promiseSlow"], [[channel, true, ~~message.tags.slow], [channel, true, ~~message.tags.slow], [null]]);
                    }
                }

                // Handle followers only mode here instead of the followers_on/off notice..
                // This room is now in follower-only mode.
                // This room is now in <duration> followers-only mode.
                // This room is no longer in followers-only mode.
                // duration is in minutes (string)
                // -1 when /followersoff (string)
                // false when /followers with no duration (boolean)
                if (message.tags.hasOwnProperty("followers-only") && !message.tags.hasOwnProperty("subs-only")) {
                    if (message.tags["followers-only"] === "-1") {
                        this.log.info(`[${channel}] This room is no longer in followers-only mode.`);
                        this.emits(["followersonly", "followersmode", "_promiseFollowersoff"], [[channel, false, 0], [channel, false, 0], [null]]);
                    } else {
                        var minutes = ~~message.tags["followers-only"];
                        this.log.info(`[${channel}] This room is now in follower-only mode.`);
                        this.emits(["followersonly", "followersmode", "_promiseFollowers"], [[channel, true, minutes], [channel, true, minutes], [null]]);
                    }
                }
                break;

            default:
                this.log.warn(`Could not parse message from tmi.twitch.tv:\n${JSON.stringify(message, null, 4)}`);
                break;
        }
    }

    // Messages from jtv..
    else if (message.prefix === "jtv") {
        switch(message.command) {
            case "MODE":
                if (msg === "+o") {
                    // Add username to the moderators..
                    if (!this.moderators[channel]) { this.moderators[channel] = []; }
                    if (!this.moderators[channel].includes(message.params[2])) { this.moderators[channel].push(message.params[2]); }

                    this.emit("mod", channel, message.params[2]);
                }
                else if (msg === "-o") {
                    // Remove username from the moderators..
                    if (!this.moderators[channel]) { this.moderators[channel] = []; }
                    this.moderators[channel].filter((value) => { return value != message.params[2]; });

                    this.emit("unmod", channel, message.params[2]);
                }
                break;

            default:
                this.log.warn(`Could not parse message from jtv:\n${JSON.stringify(message, null, 4)}`);
                break;
        }
    }

    // Anything else..
    else {
        switch(message.command) {
            case "353":
                this.emit("names", message.params[2], message.params[3].split(" "));
                break;

            case "366":
                break;

            // Someone has joined the channel..
            case "JOIN":
                var nick = message.prefix.split("!")[0];
                // Joined a channel as a justinfan (anonymous) user..
                if (_.isJustinfan(this.getUsername()) && this.username === nick) {
                    this.lastJoined = channel;
                    this.channels.push(channel);
                    this.log.info(`Joined ${channel}`);
                    this.emit("join", channel, nick, true);
                }

                // Someone else joined the channel, just emit the join event..
                if (this.username !== nick) {
                    this.emit("join", channel, nick, false);
                }
                break;

            // Someone has left the channel..
            case "PART":
                var isSelf = false;
                var nick = message.prefix.split("!")[0];
                // Client a channel..
                if (this.username === nick) {
                    isSelf = true;
                    if (this.userstate[channel]) { delete this.userstate[channel]; }

                    var index = this.channels.indexOf(channel);
                    if (index !== -1) { this.channels.splice(index, 1); }

                    var index = this.opts.channels.indexOf(channel);
                    if (index !== -1) { this.opts.channels.splice(index, 1); }

                    this.log.info(`Left ${channel}`);
                    this.emit("_promisePart", null);
                }

                // Client or someone else left the channel, emit the part event..
                this.emit("part", channel, nick, isSelf);
                break;

            // Received a whisper..
            case "WHISPER":
                var nick = message.prefix.split("!")[0];
                this.log.info(`[WHISPER] <${nick}>: ${msg}`);

                // Update the tags to provide the username..
                if (!message.tags.hasOwnProperty("username")) { message.tags.username = nick; }
                message.tags["message-type"] = "whisper";

                var from = _.channel(message.tags.username);
                // Emit for both, whisper and message..
                this.emits(["whisper", "message"], [
                    [from, message.tags, msg, false]
                ]);
                break;

            case "PRIVMSG":
                // Add username (lowercase) to the tags..
                message.tags.username = message.prefix.split("!")[0];

                // Message from JTV..
                if (message.tags.username === "jtv") {
                    var name = _.username(msg.split(" ")[0]);
                    var autohost = msg.includes("auto");
                    // Someone is hosting the channel and the message contains how many viewers..
                    if (msg.includes("hosting you for")) {
                        var count = _.extractNumber(msg);

                        this.emit("hosted", channel, name, count, autohost);
                    }

                    // Some is hosting the channel, but no viewer(s) count provided in the message..
                    else if (msg.includes("hosting you")) {
                        this.emit("hosted", channel, name, 0, autohost);
                    }
                }

                else {
                    // Message is an action (/me <message>)..
                    var actionMessage = _.actionMessage(msg);
                    if (actionMessage) {
                        message.tags["message-type"] = "action";
                        this.log.info(`[${channel}] *<${message.tags.username}>: ${actionMessage[1]}`);
                        this.emits(["action", "message"], [
                            [channel, message.tags, actionMessage[1], false]
                        ]);
                    }
                    else {
                        if (message.tags.hasOwnProperty("bits")) {
                            this.emit("cheer", channel, message.tags, msg);
                        }

                        // Message is a regular chat message..
                        else {
                            message.tags["message-type"] = "chat";
                            this.log.info(`[${channel}] <${message.tags.username}>: ${msg}`);

                            this.emits(["chat", "message"], [
                                [channel, message.tags, msg, false]
                            ]);
                        }
                    }
                }
                break;

            default:
                this.log.warn(`Could not parse message:\n${JSON.stringify(message, null, 4)}`);
                break;
        }
    }
};

// Connect to server..
client.prototype.connect = function connect() {
    return new Promise((resolve, reject) => {
        this.server = _.get(this.opts.connection.server, "irc-ws.chat.twitch.tv");
        this.port = _.get(this.opts.connection.port, 80);

        // Override port if using a secure connection..
        if (this.secure) { this.port = 443; }
        if (this.port === 443) { this.secure = true; }

        this.reconnectTimer = this.reconnectTimer * this.reconnectDecay;
        if (this.reconnectTimer >= this.maxReconnectInterval) {
            this.reconnectTimer = this.maxReconnectInterval;
        }

        // Connect to server from configuration..
        this._openConnection();
        this.once("_promiseConnect", (err) => {
            if (!err) { resolve([this.server, ~~this.port]); }
            else { reject(err); }
        });
    });
};

// Open a connection..
client.prototype._openConnection = function _openConnection() {
    this.ws = new ws(`${this.secure ? "wss" : "ws"}://${this.server}:${this.port}/`, "irc");

    this.ws.onmessage = this._onMessage.bind(this);
    this.ws.onerror = this._onError.bind(this);
    this.ws.onclose = this._onClose.bind(this);
    this.ws.onopen = this._onOpen.bind(this);
};

// Called when the WebSocket connection's readyState changes to OPEN.
// Indicates that the connection is ready to send and receive data..
client.prototype._onOpen = function _onOpen() {
    if (!_.isNull(this.ws) && this.ws.readyState === 1) {
        // Emitting "connecting" event..
        this.log.info(`Connecting to ${this.server} on port ${this.port}..`);
        this.emit("connecting", this.server, ~~this.port);

        this.username = _.get(this.opts.identity.username, _.justinfan());
        this.password = _.password(_.get(this.opts.identity.password, "SCHMOOPIIE"));

        // Emitting "logon" event..
        this.log.info("Sending authentication to server..");
        this.emit("logon");

        // Authentication..
        this.ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
        this.ws.send(`PASS ${this.password}`);
        this.ws.send(`NICK ${this.username}`);
        this.ws.send(`USER ${this.username} 8 * :${this.username}`);
    }
};

// Called when a message is received from the server..
client.prototype._onMessage = function _onMessage(event) {
    var parts = event.data.split("\r\n");

    parts.forEach((str) => {
        if (!_.isNull(str)) { this.handleMessage(parse.msg(str)); }
    });
};

// Called when an error occurs..
client.prototype._onError = function _onError() {
    this.moderators = {};
    this.userstate = {};
    this.globaluserstate = {};

    // Stop the internal ping timeout check interval..
    clearInterval(this.pingLoop);
    clearTimeout(this.pingTimeout);

    this.reason = !_.isNull(this.ws) ? "Unable to connect." : "Connection closed.";

    this.emits(["_promiseConnect", "disconnected"], [[this.reason]]);

    // Reconnect to server..
    if (this.reconnect && this.reconnections === this.maxReconnectAttempts) {
        this.emit("maxreconnect");
        this.log.error("Maximum reconnection attempts reached.");
    }
    if (this.reconnect && !this.reconnecting && this.reconnections <= this.maxReconnectAttempts-1) {
        this.reconnecting = true;
        this.reconnections = this.reconnections+1;
        this.log.error(`Reconnecting in ${Math.round(this.reconnectTimer / 1000)} seconds..`);
        this.emit("reconnect");
        setTimeout(() => { this.reconnecting = false; this.connect(); }, this.reconnectTimer);
    }

    this.ws = null;
};

// Called when the WebSocket connection's readyState changes to CLOSED..
client.prototype._onClose = function _onClose() {
    this.moderators = {};
    this.userstate = {};
    this.globaluserstate = {};

    // Stop the internal ping timeout check interval..
    clearInterval(this.pingLoop);
    clearTimeout(this.pingTimeout);

    // User called .disconnect(), don't try to reconnect.
    if (this.wasCloseCalled) {
        this.wasCloseCalled = false;
        this.reason = "Connection closed.";
        this.log.info(this.reason);
        this.emits(["_promiseConnect", "_promiseDisconnect", "disconnected"], [[this.reason], [null], [this.reason]]);
    }
    // Got disconnected from server..
    else {
        this.emits(["_promiseConnect", "disconnected"], [[this.reason]]);

        // Reconnect to server..
        if (this.reconnect && this.reconnections === this.maxReconnectAttempts) {
            this.emit("maxreconnect");
            this.log.error("Maximum reconnection attempts reached.");
        }
        if (this.reconnect && !this.reconnecting && this.reconnections <= this.maxReconnectAttempts-1) {
            this.reconnecting = true;
            this.reconnections = this.reconnections+1;
            this.log.error(`Could not connect to server. Reconnecting in ${Math.round(this.reconnectTimer / 1000)} seconds..`);
            this.emit("reconnect");
            setTimeout(() => { this.reconnecting = false; this.connect(); }, this.reconnectTimer);
        }
    }

    this.ws = null;
};

// Minimum of 600ms for command promises, if current latency exceeds, add 100ms to it to make sure it doesn't get timed out..
client.prototype._getPromiseDelay = function _getPromiseDelay() {
    if (this.currentLatency <= 600) { return 600; }
    else { return this.currentLatency + 100; }
};

// Send command to server or channel..
client.prototype._sendCommand = function _sendCommand(delay, channel, command, fn) {
    // Race promise against delay..
    return new Promise((resolve, reject) => {
        _.promiseDelay(delay).then(() => { reject("No response from Twitch."); });

        // Make sure the socket is opened..
        if (!_.isNull(this.ws) && this.ws.readyState !== 2 && this.ws.readyState !== 3) {
            // Executing a command on a channel..
            if (!_.isNull(channel)) {
                var chan = _.channel(channel);
                this.log.info(`[${chan}] Executing command: ${command}`);
                this.ws.send(`PRIVMSG ${chan} :${command}`);
            }

            // Executing a raw command..
            else {
                this.log.info(`Executing command: ${command}`);
                this.ws.send(command);
            }
            fn(resolve, reject);
        }

        // Disconnected from server..
        else { reject("Not connected to server."); }
    });
};

// Send a message to channel..
client.prototype._sendMessage = function _sendMessage(delay, channel, message, fn) {
    // Promise a result..
    return new Promise((resolve, reject) => {
        // Make sure the socket is opened and not logged in as a justinfan user..
        if (!_.isNull(this.ws) && this.ws.readyState !== 2 && this.ws.readyState !== 3 && !_.isJustinfan(this.getUsername())) {
            var chan = _.channel(channel);
            if (!this.userstate[chan]) { this.userstate[chan] = {} }

            // Split long lines otherwise they will be eaten by the server..
            if (message.length >= 500) {
                var msg = _.splitLine(message, 500);
                message = msg[0];

                setTimeout(() => {
                    this._sendMessage(delay, channel, msg[1], () => {});
                }, 350);
            }

            this.ws.send(`PRIVMSG ${chan} :${message}`);

            var emotes = {};

            // Parse regex and string emotes..
            Object.keys(this.emotesets).forEach((id) => {
                this.emotesets[id].forEach(function(emote) {
                    if (_.isRegex(emote.code)) { return parse.emoteRegex(message, emote.code, emote.id, emotes); }
                    parse.emoteString(message, emote.code, emote.id, emotes);
                });
            });

            // Merge userstate with parsed emotes..
            var userstate = _.merge(this.userstate[chan], parse.emotes({ emotes: parse.transformEmotes(emotes) || null }));

            // Message is an action (/me <message>)..
            var actionMessage = _.actionMessage(message);
            if (actionMessage) {
                userstate["message-type"] = "action";
                this.log.info(`[${chan}] *<${this.getUsername()}>: ${actionMessage[1]}`);
                this.emits(["action", "message"], [
                    [chan, userstate, actionMessage[1], true]
                ]);
            }

            // Message is a regular chat message..
            else {
                userstate["message-type"] = "chat";
                this.log.info(`[${chan}] <${this.getUsername()}>: ${message}`);
                this.emits(["chat", "message"], [
                    [chan, userstate, message, true]
                ]);
            }
            fn(resolve, reject);
        } else {
            reject("Not connected to server.");
        }
    });
};

// Grab the emote-sets object from the API..
client.prototype._updateEmoteset = function _updateEmoteset(sets) {
    this.emotes = sets;

    this.api({
        url: `/chat/emoticon_images?emotesets=${sets}`,
        headers: {
            "Authorization": `OAuth ${_.password(_.get(this.opts.identity.password, "")).replace("oauth:", "")}`,
            "Client-ID": this.clientId
        }
    }, (err, res, body) => {
        if (!err) {
            this.emotesets = body["emoticon_sets"] || {};
            return this.emit("emotesets", sets, this.emotesets);
        }
        setTimeout(() => { this._updateEmoteset(sets); }, 60000);
    });
};

// Get current username..
client.prototype.getUsername = function getUsername() {
    return this.username;
};

// Get current options..
client.prototype.getOptions = function getOptions() {
    return this.opts;
};

// Get current channels..
client.prototype.getChannels = function getChannels() {
    return this.channels;
};

// Check if username is a moderator on a channel..
client.prototype.isMod = function isMod(channel, username) {
    var chan = _.channel(channel);
    if (!this.moderators[chan]) { this.moderators[chan] = []; }
    return this.moderators[chan].includes(_.username(username));
};

// Get readyState..
client.prototype.readyState = function readyState() {
    if (_.isNull(this.ws)) { return "CLOSED"; }
    return ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][this.ws.readyState];
};

// Disconnect from server..
client.prototype.disconnect = function disconnect() {
    return new Promise((resolve, reject) => {
        if (!_.isNull(this.ws) && this.ws.readyState !== 3) {
            this.wasCloseCalled = true;
            this.log.info("Disconnecting from server..");
            this.ws.close();
            this.once("_promiseDisconnect", () => { resolve([this.server, ~~this.port]); });
        } else {
            this.log.error("Cannot disconnect from server. Socket is not opened or connection is already closing.");
            reject("Cannot disconnect from server. Socket is not opened or connection is already closing.");
        }
    });
};

client.prototype.utils = extraUtils;

// Expose everything, for browser and Node..
if (typeof module !== "undefined" && module.exports) {
    module.exports = client;
}
if (typeof window !== "undefined") {
    window.tmi = {};
    window.tmi.client = client;
    window.tmi.Client = client;
}
