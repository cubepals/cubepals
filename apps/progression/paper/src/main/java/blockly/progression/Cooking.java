// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.logging.Logger;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockState;
import org.bukkit.block.BrewingStand;
import org.bukkit.block.Campfire;
import org.bukkit.block.Furnace;
import org.bukkit.block.data.Lightable;
import org.bukkit.inventory.ItemStack;

/**
 * Furnaces, smokers, blast furnaces, brewing stands and campfires made up for a gap by running
 * Minecraft's own tick for each once for each game tick owed. So a furnace burns its fuel as it
 * would (a lava bucket leaves its bucket), cooks only what its recipes cook, stops when its output
 * is full or holds something else, cools when its fuel runs out, and keeps the experience it earned
 * for whoever takes the output; a brewing stand uses its blaze powder and brews only what brews; a
 * lit campfire cooks its food and drops it beside itself. Paper's furnace and brewing events fire for
 * other plugins as they would.
 *
 * Paper's API has no way to tick these, so the ticks are found by their names in Minecraft's own
 * code, which Paper runs under Mojang's names from 1.20.5. On an older Paper they aren't found, the
 * log says so once, and they are left as they are; everything else is still made up.
 *
 * One with nothing left to do stops being ticked: a furnace unlit and not cooking, a brewing stand
 * not brewing, a campfire out or empty. A furnace burning with nothing to cook burns its fuel down
 * at once. The same as the Fabric mod's.
 */
final class Cooking {
    /** Ticks between looks at whether it still has work, through Paper's API. */
    private static final int LOOK_EVERY = 20;

    private final MethodHandle handle;
    private final MethodHandle blockPos;
    private final MethodHandle blockEntity;
    private final MethodHandle stateOf;
    private final Ticker furnace;
    private final Ticker brewing;
    private final Ticker campfire;

    /** One kind's tick: its block entity's class, and the game's static tick for it. */
    private record Ticker(Class<?> type, MethodHandle tick, Object check) {}

    private Cooking(MethodHandle handle, MethodHandle blockPos, MethodHandle blockEntity, MethodHandle stateOf,
            Ticker furnace, Ticker brewing, Ticker campfire) {
        this.handle = handle;
        this.blockPos = blockPos;
        this.blockEntity = blockEntity;
        this.stateOf = stateOf;
        this.furnace = furnace;
        this.brewing = brewing;
        this.campfire = campfire;
    }

    /** The game's ticks on this server; null, said once, where they can't be found. */
    static Cooking find(World world, Logger logger) {
        try {
            MethodHandles.Lookup lookup = MethodHandles.publicLookup();
            Method getHandle = world.getClass().getMethod("getHandle");
            Class<?> level = getHandle.getReturnType();
            Class<?> pos = Class.forName("net.minecraft.core.BlockPos");
            Class<?> entity = Class.forName("net.minecraft.world.level.block.entity.BlockEntity");
            Ticker furnace = ticker(lookup, "AbstractFurnaceBlockEntity", "serverTick", null);
            Ticker brewing = ticker(lookup, "BrewingStandBlockEntity", "serverTick", null);
            Class<?> recipes = Class.forName("net.minecraft.world.item.crafting.RecipeManager");
            Class<?> types = Class.forName("net.minecraft.world.item.crafting.RecipeType");
            Object check = recipes.getMethod("createCheck", types)
                    .invoke(null, types.getField("CAMPFIRE_COOKING").get(null));
            Ticker campfire = ticker(lookup, "CampfireBlockEntity", "cookTick", check);
            return new Cooking(
                    lookup.unreflect(getHandle),
                    lookup.findConstructor(pos, MethodType.methodType(void.class, int.class, int.class, int.class)),
                    lookup.unreflect(level.getMethod("getBlockEntity", pos)),
                    lookup.unreflect(entity.getMethod("getBlockState")),
                    furnace, brewing, campfire);
        } catch (ReflectiveOperationException | RuntimeException e) {
            logger.info("Furnaces, brewing stands and campfires aren't caught up on this server: their ticks weren't found (" + e + ")");
            return null;
        }
    }

    private static Ticker ticker(MethodHandles.Lookup lookup, String name, String method, Object check)
            throws ReflectiveOperationException {
        Class<?> type = Class.forName("net.minecraft.world.level.block.entity." + name);
        int params = check == null ? 4 : 5;
        for (Method m : type.getMethods()) {
            if (m.getName().equals(method) && Modifier.isStatic(m.getModifiers()) && m.getParameterCount() == params
                    && m.getParameterTypes()[3] == type)
                return new Ticker(type, lookup.unreflect(m), check);
        }
        throw new NoSuchMethodException(name + "." + method);
    }

    /** Whether a block's state is one this makes up. */
    static boolean cooks(BlockState state) {
        return state instanceof Furnace || state instanceof BrewingStand || state instanceof Campfire;
    }

    /** The work of making one up for `owed` ticks. */
    Work.Job job(Block block, long owed, Totals totals) {
        return new Work.Job() {
            private long left = owed;
            private Object level;
            private Object pos;
            private boolean counted;
            private int stalled;

            @Override
            public boolean step(long deadline) {
                try {
                    if (level == null) {
                        level = handle.invoke(block.getWorld());
                        pos = blockPos.invoke(block.getX(), block.getY(), block.getZ());
                    }
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
                } catch (Throwable e) {
                    return true;
                }
            }

            /** One tick of the game's own; false where the block is gone or isn't ticking. */
            private boolean tick() throws Throwable {
                Object entity = blockEntity.invoke(level, pos);
                for (Ticker ticker : new Ticker[] {furnace, brewing, campfire}) {
                    if (!ticker.type().isInstance(entity)) continue;
                    if (ticker == campfire) {
                        if (!(block.getBlockData() instanceof Lightable lit) || !lit.isLit()) return false;
                        ticker.tick().invoke(level, pos, stateOf.invoke(entity), entity, ticker.check());
                    } else {
                        ticker.tick().invoke(level, pos, stateOf.invoke(entity), entity);
                    }
                    return true;
                }
                return false;
            }

            private boolean stillWorking() {
                BlockState state = block.getState(false);
                if (state instanceof BrewingStand stand) return stand.getBrewingTime() > 0;
                if (state instanceof Campfire fire) {
                    for (int slot = 0; slot < fire.getSize(); slot++) {
                        ItemStack food = fire.getItem(slot);
                        if (food != null && !food.getType().isAir()) return true;
                    }
                    return false;
                }
                return state instanceof Furnace f && furnaceWorking(f);
            }

            /**
             * Whether a furnace has more to do. One burning with nothing to cook (its input empty,
             * or no progress at two looks running, as with a full output) burns down now: an item
             * just finished also leaves no progress, but only for the tick after it.
             */
            private boolean furnaceWorking(Furnace furnace) {
                if (furnace.getBurnTime() <= 0) return furnace.getCookTime() > 0;
                if (furnace.getCookTime() > 0) {
                    stalled = 0;
                    return true;
                }
                ItemStack input = furnace.getInventory().getSmelting();
                if (input != null && !input.getType().isAir() && ++stalled < 2) return true;
                long burning = furnace.getBurnTime();
                if (burning > left + 1) {
                    furnace.setBurnTime((short) (burning - left));
                    left = 1;
                } else {
                    left = Math.min(left, burning + 1);
                }
                return true;
            }
        };
    }
}
