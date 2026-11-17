// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.random.RandomGenerator;
import org.bukkit.Chunk;
import org.bukkit.GameRule;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.entity.Breedable;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Sheep;
import org.bukkit.persistence.PersistentDataContainer;
import org.bukkit.persistence.PersistentDataType;

/**
 * A chunk's animals made up for a gap (`Animals`): babies grow up and parents' wait to breed runs
 * out (`Breedable.setAge`, which grows a baby as the game does); and a sheared sheep that would have
 * eaten grass where it stands has, as its eat-grass goal does: short grass at its feet is eaten, or
 * the grass block under it turns to dirt, both only where `mobGriefing` lets mobs change blocks, and
 * either way its wool grows back, and a lamb grows a minute. An animal whose age is locked stays as
 * it is. Each keeps, in its own persistent data, the moment it was made up to, so one that walked in
 * from a chunk already made up isn't made up twice (`Animals.owedSince`). The same as the Fabric
 * mod's.
 */
final class Herds {
    /** Grass as a sheep eats it at its feet: `SHORT_GRASS`, called `GRASS` before 1.20.3. */
    private static final Material SHORT_GRASS =
            Material.getMaterial("SHORT_GRASS") != null ? Material.getMaterial("SHORT_GRASS") : Material.getMaterial("GRASS");

    /** What a lamb's eating grass takes off its age: a minute (`Sheep.ate`). */
    private static final int LAMB_EATS = 1_200;

    private Herds() {}

    /** Where an animal keeps the moment it was last made up to, on the wall clock. */
    private static final NamespacedKey STAMP = new NamespacedKey("cubepals", "progressed");

    /** Makes up every animal in a chunk whose entities are loaded; returns how many changed. */
    static int catchUp(Chunk chunk, long chunkOwed, long now, RandomGenerator random) {
        Boolean rule = chunk.getWorld().getGameRuleValue(GameRule.MOB_GRIEFING);
        boolean griefing = rule == null || rule;
        int changed = 0;
        for (Entity entity : chunk.getEntities()) {
            if (!(entity instanceof Breedable animal) || animal.getAgeLock()) continue;
            PersistentDataContainer data = animal.getPersistentDataContainer();
            long owed = Animals.owedSince(chunkOwed, data.get(STAMP, PersistentDataType.LONG), now);
            data.set(STAMP, PersistentDataType.LONG, now);
            boolean did = false;
            int age = animal.getAge();
            int after = Animals.ageAfter(age, owed);
            if (after != age) {
                animal.setAge(after);
                did = true;
            }
            if (animal instanceof Sheep sheep && sheep.isSheared() && grazes(sheep)
                    && Animals.ate(owed, !sheep.isAdult(), random)) {
                eat(sheep, griefing);
                did = true;
            }
            if (did) changed++;
        }
        return changed;
    }

    private static boolean grazes(Sheep sheep) {
        Block feet = sheep.getLocation().getBlock();
        return feet.getType() == SHORT_GRASS || feet.getRelative(BlockFace.DOWN).getType() == Material.GRASS_BLOCK;
    }

    private static void eat(Sheep sheep, boolean griefing) {
        Block feet = sheep.getLocation().getBlock();
        if (griefing) {
            if (feet.getType() == SHORT_GRASS) feet.setType(Material.AIR, false);
            else feet.getRelative(BlockFace.DOWN).setType(Material.DIRT, false);
        }
        sheep.setSheared(false);
        if (!sheep.isAdult()) sheep.setAge(Math.min(0, sheep.getAge() + LAMB_EATS));
    }
}
