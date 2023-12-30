"use strict";
const fs = require("fs");
const Discord = require("discord.js");
const { Permissions } = require("discord.js");
const { Manager, TrackUtils } = require("erela.js");
const { clientRedis, clientRedisNoAsync } = require("./utils/redis");
const Sentry = require("@sentry/node");
const Tracing = require("@sentry/tracing");
const Spotify = require("better-erela.js-spotify").default;
const redisScan = require("node-redis-scan");

const {
    token,
    lavalinkNodes,
    sentryDSN,
    sentryEnv,
    spotifyClientID,
    spotifyClientSecret,
} = require("./config.json"); //skipcq: JS-0266

const client = new Discord.Client({
    intents: [
        Discord.Intents.FLAGS.GUILDS,
        Discord.Intents.FLAGS.GUILD_VOICE_STATES,
        Discord.Intents.FLAGS.DIRECT_MESSAGES,
        Discord.Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    ],
});
client.commands = new Discord.Collection();

Sentry.init({
    dsn: sentryDSN,
    tracesSampleRate: 1.0,
    environment: sentryEnv,
});

client.manager = new Manager({
    nodes: lavalinkNodes,

    plugins: [
        new Spotify({
            strategy: 'SCRAPE'
        }),
    ],
    send(id, payload) {
        const guild = client.guilds.cache.get(id);
        if (guild) {
            guild.shard.send(payload);
        }
    },
})
    .on("nodeConnect", (node) => {
        console.log(`Node ${node.options.identifier} connected`); //skipcq: JS-0002

        // go through redis and check if theer are any queues that need playing if the bot has crashed.
        const scanner = new redisScan(clientRedisNoAsync);
        scanner.eachScan(
            "guild_*",
            async (matchingKeys) => {
                // Depending on the pattern being scanned for, many or most calls to
                // this function will be passed an empty array.
                if (matchingKeys.length) {
                    // Matching keys found after this iteration of the SCAN command.
                    for (let i = 0; i < matchingKeys.length; i++) {
                        const redisQueue = await clientRedis.get(matchingKeys[i]);
                        const serverQueue = JSON.parse(redisQueue);
                        if (client.manager.get(serverQueue.textChannel.guildId)) return;
                        const node = await client.manager.leastLoadNodes;
                        const player = client.manager.create({
                            guild: serverQueue.voiceChannel.guildId,
                            voiceChannel: serverQueue.voiceChannel.id,
                            textChannel: serverQueue.textChannel.id,
                            selfDeafen: true,
                            node: node[0],
                        });
                        await player.connect();
                        // check for spotify tracks played from /playlist command
                        if (!serverQueue.songs[0]?.url) {
                            const unersolvedTrack = TrackUtils.buildUnresolved({
                                title: serverQueue.songs[0].title,
                                author: serverQueue.songs[0].author,
                                duration: serverQueue.songs[0].duration,
                            });
                            return player.play(unersolvedTrack);
                        }
                        const response = await client.manager.search(
                            serverQueue.songs[0].url
                        );
                        player.play(response.tracks[0]);

                        await player.play(response.tracks[0]);
                    }
                }
            },
            (err, matchCount) => {
                if (err) throw err;

                // matchCount will be an integer count of how many total keys
                // were found and passed to the intermediate callback.
                console.log(`Found ${matchCount} keys.`);
            }
        );
    })
    .on(
        "nodeError",
        (node, error) =>
            console.log(
                `Node ${node.options.identifier} had an error: ${error.message}`
            ) //skipcq: JS-0002
    )
    .on("trackStart", async (player, track) => {
        const redisReply = await clientRedis.get(`guild_${player.guild}`);
        const serverQueue = JSON.parse(redisReply);
        if (!player.textChannel) return;
        if (
            !client.channels.cache
                .get(player.textChannel)
                .permissionsFor(client.user.id)
                .has([
                    Permissions.FLAGS.SEND_MESSAGES,
                    Permissions.FLAGS.EMBED_LINKS,
                    Permissions.FLAGS.VIEW_CHANNEL,
                ])
        )
            return;
        const newQueueEmbed = new Discord.MessageEmbed()
            .setColor("#ed1c24")
            .setTitle(track.title)
            .setURL(track.uri)
            .setAuthor(client.user.username, client.user.avatarURL())
            .setDescription(
                `[${track.title}](${track.uri}) is now playing and is number 1 in the queue!`
            )
            .setThumbnail(track.thumbnail);

        const Buttons = new Discord.MessageActionRow().addComponents(
            new Discord.MessageButton()
                .setCustomId("stop")
                .setLabel("⏹️")
                .setStyle("SECONDARY"),

            new Discord.MessageButton()
                .setCustomId("pause")
                .setLabel("⏯️")
                .setStyle("SECONDARY"),

            new Discord.MessageButton()
                .setCustomId("skip")
                .setLabel("⏭️")
                .setStyle("SECONDARY")
        );

        const message = await client.channels.cache.get(player.textChannel).send({
            embeds: [newQueueEmbed],
            components: [Buttons],
        });

        const collector = message.createMessageComponentCollector({
            time: serverQueue.songs[0].duration,
        });

        collector.on("collect", async (i) => {
            if (i.customId === "stop") {
                if (!player) {
                    return collector.stop();
                }
                serverQueue.songs = [];
                await clientRedis.set(
                    `guild_${i.guildId}`,
                    JSON.stringify(serverQueue)
                );
                await player.stop();
                i.reply("Stoping the music!");
                return collector.stop();
            } else if (i.customId === "pause") {
                if (!player) {
                    return collector.stop();
                }
                player.pause(!player.paused);
                const pauseText = player.paused ? "paused" : "unpaused";
                i.reply(`I have ${pauseText} the music!`);
            } else if (i.customId === "skip") {
                if (!player) {
                    return collector.stop();
                }
                await player.stop();
                i.reply("I have skipped to the next song!");
                if (serverQueue.songs.length === 1) {
                    return collector.stop();
                }
                return;
            }
        });
    })
    .on("queueEnd", async (player) => {
        const redisReply = await clientRedis.get(`guild_${player.guild}`);
        const serverQueue = JSON.parse(redisReply);
        serverQueue.songs.shift();
        let endMsg = false;
        if (!serverQueue.songs[0]) {
            await clientRedis.del(`guild_${player.guild}`);
            player.destroy();
            endMsg = true;
        } else {
            await clientRedis.set(`guild_${player.guild}`, JSON.stringify(serverQueue));
            // check for spotify tracks played from /playlist command
            const unersolvedTrack = TrackUtils.buildUnresolved({
                title: serverQueue.songs[0].title,
                author: serverQueue.songs[0].author,
                duration: serverQueue.songs[0].duration,
            });
            player.play(unersolvedTrack);
        }


        let sendMessage = true;
        if (!player.textChannel) {
            await clientRedis.del(`guild_${player.guild}`);
            return player.destroy();
        }
        if (
            !client.channels.cache
                .get(player.textChannel)
                .permissionsFor(client.user.id)
                .has([Permissions.FLAGS.SEND_MESSAGES, Permissions.FLAGS.VIEW_CHANNEL])
        ) {
            sendMessage = false;
        }

        if (sendMessage && endMsg) {
            client.channels.cache
                .get(player.textChannel)
                .send("No more songs in queue, leaving voice channel!");
        }
    })
    .on("playerMove", async (player, oldChannel, newChannel) => {
        if (!newChannel) {
            await clientRedis.del(`guild_${player.guild}`);
            return player.destroy();
        }
        const position = player.position;
        await player.setVoiceChannel(newChannel);
        await player.play(player.queue.current);
        return player.seek(position);
    });

const commandFiles = fs
    .readdirSync("./commands")
    .filter((file) => file.endsWith(".js"));

for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    client.commands.set(command.name, command);
}

client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}!`); //skipcq: JS-0002
    client.manager.init(client.user.id);
    client.user.setActivity("for /help", { type: "WATCHING" });
});

// send voice events to lavalink library

client.on("raw", (d) => client.manager.updateVoiceState(d));

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isCommand()) return;
    await interaction.deferReply();

    if (
        !interaction.channel
            .permissionsFor(interaction.client.user.id)
            .has(Permissions.FLAGS.SEND_MESSAGES)
    ) {
        try {
            const errorEmbed = new Discord.MessageEmbed()
                .setColor("#ed1c24")
                .setTitle(`Missing Permissions in Guild ${interaction.guild.name}!`)
                .setDescription(
                    `Hey! You just ran the ${interaction.commandName} command on server ${interaction.guild.name} but I don't have permission to send messages on that channel. Please make sure that I have send messages permission for that channel and try again.`
                );

            return interaction.user.send({ embeds: [errorEmbed] });
        } catch {
            return;
        }
    }

    if (
        !interaction.channel
            .permissionsFor(interaction.client.user.id)
            .has(Permissions.FLAGS.EMBED_LINKS)
    ) {
        return interaction.editReply(
            "I need permission to send embeds in this channel!"
        );
    }

    if (
        !interaction.channel
            .permissionsFor(interaction.client.user.id)
            .has(Permissions.FLAGS.VIEW_CHANNEL)
    ) {
        return interaction.editReply("I need permission to view this channel!");
    }

    const command = client.commands.get(interaction.commandName);

    if (command.guildOnly) {
        if (!interaction.guild) {
            return interaction.editReply("This command can only be ran in guilds!");
        }
    }

    if (command.voice) {
        if (!interaction.member.voice.channel) {
            return interaction.editReply("You are not in a voice channel!");
        }
    }

    const transaction = Sentry.startTransaction({
        op: "command",
        name: "Command ran on Boombox",
    });

    try {
        await command.execute(interaction);
    } catch (err) {
        console.error(err); //skipcq: JS-0002
        interaction.editReply("There was an error trying to execute that command!");
        Sentry.captureException(err);
    } finally {
        transaction.finish();
    }
});

client.login(token)