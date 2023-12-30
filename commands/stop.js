"use strict";
const { clientRedis } = require("../utils/redis");
const { SlashCommandBuilder } = require("@discordjs/builders");

module.exports = {
  name: "stop",
  description: "Stop's the currnet playing song and deletes the queue.",
  args: false,
  guildOnly: true,
  voice: true,
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop's the currnet playing song and deletes the queue."),
  async execute(interaction) {
    const manager = interaction.client.manager;

    const player = manager.get(interaction.guildId);

    const redisReply = await clientRedis.get(`guild_${interaction.guildId}`);

    const serverQueue = JSON.parse(redisReply);

    if (!player) {
      console.log(serverQueue)
      if (serverQueue || serverQueue.songs) {
        clientRedis.del(`guild_${interaction.guildId}`);
        return interaction.editReply("All songs from the queue have been removed.")
      }
      return interaction.editReply("There is currently no song playing!");
    }

    serverQueue.songs = [];
    clientRedis.set(
      `guild_${interaction.guildId}`,
      JSON.stringify(serverQueue)
    );

    interaction.editReply("I removed all songs from the queue!");

    return player.stop();
  },
};
