// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import blockly.progression.mixin.BrewingAccess;
import blockly.progression.mixin.FurnaceAccess;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.crafting.CampfireCookingRecipe;
import net.minecraft.world.item.crafting.RecipeManager;
import net.minecraft.world.item.crafting.RecipeType;
import net.minecraft.world.item.crafting.SingleRecipeInput;
import net.minecraft.world.level.block.CampfireBlock;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import net.minecraft.world.level.block.entity.CampfireBlockEntity;

/**
 * Furnaces, smokers, blast furnaces, brewing stands and campfires made up for a gap by running
 * Minecraft's own tick for each once for each game tick owed. So a furnace burns its fuel as it
 * would (a lava bucket leaves its bucket), cooks only what its recipes cook, stops when its output
 * is full or holds something else, cools when its fuel runs out, and keeps the experience it earned
 * for whoever takes the output; a brewing stand uses its blaze powder and brews only what brews; a
 * lit campfire cooks its food and drops it beside itself, as it does.
 *
 * One with nothing left to do stops being ticked: a furnace unlit and not cooking, a brewing stand
 * not brewing, a campfire out or empty, can only start again with something a player or a hopper
 * brings. A furnace burning with nothing to cook burns its fuel down at once rather than tick by
 * tick. The same as the Paper plugin's (`../paper`'s `Cooking`).
 */
final class Cooking {
    /** Ticks between looks at whether it still has work. */
    private static final int LOOK_EVERY = 20;

    private static final RecipeManager.CachedCheck<SingleRecipeInput, CampfireCookingRecipe> CAMPFIRE =
            RecipeManager.createCheck(RecipeType.CAMPFIRE_COOKING);

    private Cooking() {}

    /** Whether a block entity is one this makes up. */
    static boolean cooks(BlockEntity entity) {
        return entity instanceof AbstractFurnaceBlockEntity
                || entity instanceof BrewingStandBlockEntity
                || entity instanceof CampfireBlockEntity;
    }

    static Work.Job job(ServerLevel level, BlockPos pos, long owed, Totals totals) {
        return new Work.Job() {
            private long left = owed;
            private boolean counted;
            private int stalled;

            @Override
            public boolean step(long deadline) {
                while (left > 0) {
                    if (System.nanoTime() >= deadline) return false;
                    for (int i = 0; i < LOOK_EVERY && left > 0; i++, left--) if (!tick()) return true;
                    if (!stillWorking()) return true;
                    if (!counted) {
                        totals.furnaces++;
                        counted = true;
                    }
                }
                return true;
            }

            /** One tick of the game's own; false where the block is gone or isn't ticking. */
            private boolean tick() {
                BlockEntity entity = level.getBlockEntity(pos);
                if (entity instanceof AbstractFurnaceBlockEntity furnace)
                    AbstractFurnaceBlockEntity.serverTick(level, pos, furnace.getBlockState(), furnace);
                else if (entity instanceof BrewingStandBlockEntity stand)
                    BrewingStandBlockEntity.serverTick(level, pos, stand.getBlockState(), stand);
                else if (entity instanceof CampfireBlockEntity fire && fire.getBlockState().getValue(CampfireBlock.LIT))
                    CampfireBlockEntity.cookTick(level, pos, fire.getBlockState(), fire, CAMPFIRE);
                else return false;
                return true;
            }

            private boolean stillWorking() {
                BlockEntity entity = level.getBlockEntity(pos);
                if (entity instanceof BrewingStandBlockEntity stand) return ((BrewingAccess) stand).cubepals$brewing() > 0;
                if (entity instanceof CampfireBlockEntity fire) {
                    for (ItemStack food : fire.getItems()) if (!food.isEmpty()) return true;
                    return false;
                }
                return entity instanceof AbstractFurnaceBlockEntity furnace && furnaceWorking(furnace);
            }

            /**
             * Whether a furnace has more to do. One burning with nothing to cook (its input empty,
             * or no progress at two looks running, as with a full output) burns down now: an item
             * just finished also leaves no progress, but only for the tick after it.
             */
            private boolean furnaceWorking(AbstractFurnaceBlockEntity furnace) {
                FurnaceAccess access = (FurnaceAccess) furnace;
                int burning = access.cubepals$lit();
                if (burning <= 0) return access.cubepals$cooking() > 0;
                if (access.cubepals$cooking() > 0) {
                    stalled = 0;
                    return true;
                }
                if (!furnace.getItem(0).isEmpty() && ++stalled < 2) return true;
                if (burning > left + 1) {
                    access.cubepals$setLit((int) (burning - left));
                    left = 1;
                } else {
                    left = Math.min(left, burning + 1L);
                }
                return true;
            }
        };
    }
}
