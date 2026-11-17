// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.World;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * Offline world progression: the plugin Cubepals places on Paper servers so a base keeps going
 * while nobody is near it. Furnaces finish what they were smelting and crops keep growing while
 * their chunks are unloaded, while their players are in another dimension, and while the whole
 * server is stopped or asleep, made up by the wall clock as each chunk ticks again (`Clock`,
 * `Chunks`), with Minecraft's own rules (`Cooking`, `RandomTicking`, `Herds`, `FireSpread`), in the
 * parts its owner left on (`Part`), a little each tick (`Work`).
 *
 * It loads before the worlds, so the chunks around spawn are followed from their first load.
 */
public final class Progression extends JavaPlugin {
    private Chunks chunks;

    @Override
    public void onEnable() {
        Work work = new Work(System::nanoTime);
        chunks = new Chunks(System::currentTimeMillis, work, Part.fromEnv(System.getenv(Part.ENV)));
        getServer().getPluginManager().registerEvents(chunks, this);
        for (World world : Bukkit.getWorlds()) for (Chunk chunk : world.getLoadedChunks()) chunks.follow(chunk);
        // The game's own ticks are looked for once the server runs its first tick, with its worlds
        // up: they are found through one. The first catch-up comes later, at the first pass.
        Bukkit.getScheduler().runTask(this, () -> {
            chunks.useCooking(Cooking.find(Bukkit.getWorlds().get(0), getLogger()));
            long start = System.nanoTime();
            int kinds = chunks.warm();
            getLogger().info("Sorted " + kinds + " kinds of block in " + (System.nanoTime() - start) / 1_000_000 + " ms.");
        });
        Bukkit.getScheduler().runTaskTimer(this, chunks::pass, 20, 20);
        Bukkit.getScheduler().runTaskTimer(this, () -> {
            work.run();
            Totals done = chunks.finished();
            if (done != null) getLogger().info(done.line());
        }, 1, 1);
    }

    @Override
    public void onDisable() {
        if (chunks != null) chunks.stampAll();
    }
}
