// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * Offline world progression on Fabric: the mod Cubepals places on Fabric servers so a base keeps
 * going while nobody is near it. Furnaces finish what they were smelting and crops keep growing
 * while their chunks are unloaded, while their players are in another dimension, and while the
 * whole server is stopped or asleep, made up by the wall clock as each chunk ticks again
 * (`Clock`, `Level`), with Minecraft's own rules (`Cooking`, `RandomTicking`, `Herds`,
 * `FireSpread`), in the parts its owner left on (`Part`), a little each tick
 * (`Work`). It does what the Paper plugin does (`../paper`), through the game's own code.
 *
 * What its mixins call (`mixin/ServerLevelMixin`), each on the server's thread.
 */
public final class FabricProgression {
    /** The parts its owner left on, as this start was given them (`Part.ENV`). */
    static final Set<Part> PARTS = Part.fromEnv(System.getenv(Part.ENV));

    private static final Map<ServerLevel, Level> LEVELS = new WeakHashMap<>();

    private FabricProgression() {}

    /** A chunk the game is about to tick. */
    public static void ticked(ServerLevel level, LevelChunk chunk) {
        of(level).ticked(chunk, System.currentTimeMillis());
    }

    /** The level's tick is over: some catch-up, within the tick's budget. */
    public static void tickEnd(ServerLevel level) {
        of(level).tickEnd(System.currentTimeMillis());
    }

    public static void unloading(ServerLevel level, LevelChunk chunk) {
        of(level).unloading(chunk);
    }

    public static void saving(ServerLevel level) {
        of(level).saving();
    }

    private static Level of(ServerLevel level) {
        return LEVELS.computeIfAbsent(level, l -> new Level(l, System.currentTimeMillis()));
    }
}
