// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.random.RandomGenerator;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.AgeableMob;
import net.minecraft.world.entity.animal.sheep.Sheep;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.gamerules.GameRules;
import net.minecraft.world.phys.AABB;

/**
 * A chunk's animals made up for a gap (`Animals`): babies grow up and parents' wait to breed runs
 * out, by `AgeableMob.setAge`, which is what lets a baby grow as the game grows it; and a sheared
 * sheep that would have eaten grass where it stands has, as its eat-grass goal does: short grass at
 * its feet is eaten, or the grass block under it turns to dirt, both only where `mobGriefing` lets
 * mobs change blocks, and either way its wool grows back (`Sheep.ate`). An animal whose age a
 * player locked stays as it is.
 *
 * Only animals in the chunk once its entities have loaded, which can come a little after its
 * blocks (`ChunkCatchUp` waits for them). Each keeps, as one of its tags, the moment it was made
 * up to, so one that walked in from a chunk already made up isn't made up twice (`Animals.owedSince`).
 */
final class Herds {
    private Herds() {}

    /** The tag an animal keeps the moment it was last made up to in, on the wall clock. */
    private static final String STAMP = "cubepals_progressed_";

    /** Makes up every animal in the chunk; returns how many changed. */
    static int catchUp(ServerLevel level, LevelChunk chunk, long chunkOwed, long now, RandomGenerator random) {
        int changed = 0;
        AABB area = new AABB(
                chunk.getPos().getMinBlockX(), level.getMinY(), chunk.getPos().getMinBlockZ(),
                chunk.getPos().getMaxBlockX() + 1, level.getMaxY() + 1, chunk.getPos().getMaxBlockZ() + 1);
        boolean griefing = level.getGameRules().get(GameRules.MOB_GRIEFING);
        for (AgeableMob animal : level.getEntitiesOfClass(AgeableMob.class, area)) {
            long owed = Animals.owedSince(chunkOwed, stampOf(animal), now);
            stamp(animal, now);
            boolean did = false;
            int age = animal.getAge();
            int after = Animals.ageAfter(age, owed);
            if (after != age && !animal.isAgeLocked()) {
                animal.setAge(after);
                did = true;
            }
            if (animal instanceof Sheep sheep && sheep.isSheared() && grazes(level, sheep, griefing)
                    && Animals.ate(owed, sheep.isBaby(), random)) {
                eat(level, sheep, griefing);
                did = true;
            }
            if (did) changed++;
        }
        return changed;
    }

    /** When an animal was last made up to; null for one never made up. */
    private static Long stampOf(AgeableMob animal) {
        for (String tag : animal.entityTags())
            if (tag.startsWith(STAMP)) {
                try {
                    return Long.parseLong(tag.substring(STAMP.length()));
                } catch (NumberFormatException e) {
                    return null;
                }
            }
        return null;
    }

    /** Keeps the moment as one of the animal's own tags, which it saves with itself. */
    private static void stamp(AgeableMob animal, long now) {
        for (String tag : java.util.List.copyOf(animal.entityTags())) if (tag.startsWith(STAMP)) animal.removeTag(tag);
        animal.addTag(STAMP + now);
    }

    /** Whether a sheep stands where its eat-grass goal could eat: short grass at its feet, or grass under it. */
    private static boolean grazes(ServerLevel level, Sheep sheep, boolean griefing) {
        BlockPos feet = sheep.blockPosition();
        return level.getBlockState(feet).is(Blocks.SHORT_GRASS) || level.getBlockState(feet.below()).is(Blocks.GRASS_BLOCK);
    }

    /** What the eat-grass goal does as it ends: the grass eaten where mobs may change blocks, and the wool back. */
    private static void eat(ServerLevel level, Sheep sheep, boolean griefing) {
        BlockPos feet = sheep.blockPosition();
        BlockState at = level.getBlockState(feet);
        if (griefing) {
            if (at.is(Blocks.SHORT_GRASS)) level.destroyBlock(feet, false);
            else level.setBlock(feet.below(), Blocks.DIRT.defaultBlockState(), 2);
        }
        sheep.ate();
    }
}
