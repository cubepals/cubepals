// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.bukkit.Material;
import org.bukkit.block.data.BlockData;

/**
 * Each kind of block's part (`Part`) and whether it spreads, read once a kind from the class of
 * Minecraft's own block and those it extends, so the plugin sorts blocks as the Fabric mod does.
 * Paper's API doesn't say what a block is in the game's terms; its block data holds the game's
 * own state, whose block is found by what it returns, a `Block`, since a method's name in Paper
 * before 1.20.5 isn't Mojang's though its classes' are. Where even that can't be read, a kind has no
 * part, and nothing of it is made up.
 */
final class Classes {
    private final Map<Material, List<String>> chains = new EnumMap<>(Material.class);
    /** The block data's `getState`, and the state's method that gives its block: found once. */
    private Method getState;
    private Method getBlock;
    private boolean unreadable;

    /** The block's class's simple name and those of the classes it extends, its own first; empty where unread. */
    List<String> of(BlockData data) {
        return chains.computeIfAbsent(data.getMaterial(), m -> read(data));
    }

    Part partOf(BlockData data) {
        return Part.of(of(data));
    }

    /**
     * Reads every kind of block's part now, once, as the server starts: done the first time a chunk
     * is caught up, it would hold up the tick a player's join brings. Returns how many.
     */
    int warm() {
        int kinds = 0;
        for (Material material : Material.values()) {
            if (material.isLegacy() || !material.isBlock()) continue;
            partOf(material);
            kinds++;
        }
        return kinds;
    }

    /** A kind of block's part, read from its default state; null for none, or for an item. */
    Part partOf(Material material) {
        if (!material.isBlock()) return null;
        return Part.of(chains.computeIfAbsent(material, m -> read(m.createBlockData())));
    }

    private List<String> read(BlockData data) {
        List<String> names = new ArrayList<>();
        if (unreadable) return names;
        try {
            if (getState == null) getState = data.getClass().getMethod("getState");
            Object state = getState.invoke(data);
            if (getBlock == null) {
                for (Method method : state.getClass().getMethods()) {
                    if (method.getParameterCount() == 0
                            && method.getReturnType().getName().equals("net.minecraft.world.level.block.Block")) {
                        getBlock = method;
                        break;
                    }
                }
                if (getBlock == null) throw new NoSuchMethodException("the state's block");
            }
            Object block = getBlock.invoke(state);
            for (Class<?> c = block.getClass(); c != Object.class; c = c.getSuperclass()) names.add(c.getSimpleName());
        } catch (ReflectiveOperationException | RuntimeException e) {
            unreadable = true;
            names.clear();
        }
        return names;
    }
}
