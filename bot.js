/* WhatsAsena - Yusuf Usta
   Güncel: Heroku + Baileys v4+ uyumlu, session hatasına karşı güvenli
*/

const fs = require("fs");
const path = require("path");
const events = require("./events");
const chalk = require('chalk');
const config = require('./config');
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason, fetchLatestBaileysVersion, MessageType, Mimetype, Presence } = require('@adiwajshing/baileys');
const { Message, StringSession, Image, Video } = require('./whatsasena/');
const { DataTypes } = require('sequelize');
const { GreetingsDB, getMessage } = require("./plugins/sql/greetings");
const got = require('got');

// Sql
const WhatsAsenaDB = config.DATABASE.define('WhatsAsena', {
    info: {
      type: DataTypes.STRING,
      allowNull: false
    },
    value: {
        type: DataTypes.TEXT,
        allowNull: false
    }
});

fs.readdirSync('./plugins/sql/').forEach(plugin => {
    if(path.extname(plugin).toLowerCase() == '.js') {
        require('./plugins/sql/' + plugin);
    }
});

const plugindb = require('./plugins/sql/plugin');

// String format fonksiyonu
String.prototype.format = function () {
    var i = 0, args = arguments;
    return this.replace(/{}/g, function () {
      return typeof args[i] != 'undefined' ? args[i++] : '';
    });
};

// Array remove fonksiyonu
Array.prototype.remove = function() {
    var what, a = arguments, L = a.length, ax;
    while (L && this.length) {
        what = a[--L];
        while ((ax = this.indexOf(what)) !== -1) {
            this.splice(ax, 1);
        }
    }
    return this;
};

async function whatsAsena () {
    await config.DATABASE.sync();

    var StrSes_Db = await WhatsAsenaDB.findAll({ where: { info: 'StringSession' } });
    const Session = new StringSession();
    let authInfo;

    // Session yükleme
    try {
        if (StrSes_Db.length < 1) {
            authInfo = Session.deCrypt(config.SESSION);
        } else {
            authInfo = Session.deCrypt(StrSes_Db[0].dataValues.value);
        }

        if (!authInfo || !authInfo.WABrowserId) {
            console.log(chalk.red.bold('❌ Geçerli bir StringSession bulunamadı!'));
            return;
        }
    } catch (err) {
        console.log(chalk.red.bold('❌ StringSession yüklenirken hata oluştu!'), err);
        return;
    }

    // WhatsApp Bağlantısı
    const { state, saveState } = useSingleFileAuthState('./auth_info.json'); // session backup
    const { version } = await fetchLatestBaileysVersion();
    const conn = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        version
    });

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(chalk.green.bold('✅ Login successful!'));
        } else if (connection === 'close') {
            const reason = lastDisconnect.error?.output?.statusCode;
            console.log(chalk.red.bold(`❌ Bağlantı kapandı: ${reason}`));
        }
    });

    conn.ev.on('creds.update', saveState);

    // Plugin yükleme
    console.log(chalk.blueBright.italic('⬇️ Installing external plugins...'));
    var plugins = await plugindb.PluginDB.findAll();
    for (const plugin of plugins) {
        if (!fs.existsSync('./plugins/' + plugin.dataValues.name + '.js')) {
            const response = await got(plugin.dataValues.url);
            if (response.statusCode == 200) {
                fs.writeFileSync('./plugins/' + plugin.dataValues.name + '.js', response.body);
                require('./plugins/' + plugin.dataValues.name + '.js');
            }
        }
    }

    fs.readdirSync('./plugins').forEach(plugin => {
        if(path.extname(plugin).toLowerCase() == '.js') {
            require('./plugins/' + plugin);
        }
    });

    console.log(chalk.green.bold('✅ Plugins installed!'));

    // Mesaj eventleri
    conn.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid == 'status@broadcast') return;

        if (config.NO_ONLINE) {
            await conn.sendPresenceUpdate('unavailable', msg.key.remoteJid);
        }

        // Stub tipleri: goodbye / welcome
        if ([32, 28].includes(msg.messageStubType)) {
            var gb = await getMessage(msg.key.remoteJid, 'goodbye');
            if (gb) await conn.sendMessage(msg.key.remoteJid, gb.message, MessageType.text);
            return;
        } else if ([27, 31].includes(msg.messageStubType)) {
            var gb = await getMessage(msg.key.remoteJid);
            if (gb) await conn.sendMessage(msg.key.remoteJid, gb.message, MessageType.text);
            return;
        }

        // Komutlar
        events.commands.map(async (command) => {
            let text_msg;
            if (msg.message.imageMessage && msg.message.imageMessage.caption) text_msg = msg.message.imageMessage.caption;
            else if (msg.message.videoMessage && msg.message.videoMessage.caption) text_msg = msg.message.videoMessage.caption;
            else if (msg.message.extendedTextMessage) text_msg = msg.message.extendedTextMessage.text;
            else if (msg.message.conversation) text_msg = msg.message.conversation;

            if (!text_msg) return;

            if ((command.pattern && command.pattern.test(text_msg)) ||
                (command.on && ((command.on === 'image' && msg.message.imageMessage) ||
                               (command.on === 'video' && msg.message.videoMessage) ||
                               (command.on === 'text' && text_msg)))) {

                let sendMsg = false;
                const chat = conn.chats?.get(msg.key.remoteJid);

                if ((config.SUDO && !msg.key.fromMe && command.fromMe) &&
                    (msg.participant ? config.SUDO.split(',').includes(msg.participant.split('@')[0]) : false)
                ) sendMsg = true;
                else if (command.fromMe === msg.key.fromMe || command.fromMe === false) sendMsg = true;

                if (!sendMsg) return;

                if (config.SEND_READ && !command.on) await conn.chatRead(msg.key.remoteJid);

                let match = text_msg.match(command.pattern);
                let whats;
                if (command.on === 'image' && msg.message.imageMessage) whats = new Image(conn, msg);
                else if (command.on === 'video' && msg.message.videoMessage) whats = new Video(conn, msg);
                else whats = new Message(conn, msg);

                if (command.deleteCommand && msg.key.fromMe) await whats.delete();

                try {
                    await command.function(whats, match);
                } catch (error) {
                    await conn.sendMessage(conn.user.id, `*-- ERROR REPORT [WHATSASENA] --*\n\`\`\`${error}\`\`\``, MessageType.text);
                }
            }
        });
    });
}

whatsAsena();
