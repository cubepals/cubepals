// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import it.unimi.dsi.fastutil.longs.Long2LongOpenHashMap;
import java.util.stream.LongStream;
import net.minecraft.resources.Identifier;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.level.saveddata.SavedData;
import net.minecraft.world.level.saveddata.SavedDataType;

/**
 * A level's stamps (`Clock`) for its chunks while they are unloaded, and the game time the mod
 * last saw the level at and its floor (`Clock.floor`), kept as the level's own saved data, which Minecraft writes
 * with the level each time it saves: sixteen bytes a chunk the mod has seen ticked.
 */
final class Stamps extends SavedData {
    /** `seen` for a level the mod never saw. */
    private static final long NEVER = Long.MIN_VALUE;

    private static final Codec<Stamps> CODEC = RecordCodecBuilder.create(fields -> fields.group(
                    Codec.LONG.fieldOf("seen").forGetter(stamps -> stamps.seen == null ? NEVER : stamps.seen),
                    Codec.LONG.optionalFieldOf("floor", NEVER).forGetter(stamps -> stamps.floor == null ? NEVER : stamps.floor),
                    Codec.LONG_STREAM.fieldOf("chunks").forGetter(stamps -> flat(stamps.chunks)),
                    Codec.LONG_STREAM.optionalFieldOf("animals", LongStream.empty())
                            .forGetter(stamps -> flat(stamps.animals)))
            .apply(fields, Stamps::new));

    /**
     * Its file, `data/cubepals/progression.dat`. Read through the data fixes for command storage,
     * which leave a compound of a mod's own as it is: Minecraft runs some fix on every saved file.
     */
    static final SavedDataType<Stamps> TYPE = new SavedDataType<>(
            Identifier.fromNamespaceAndPath("cubepals", "progression"),
            Stamps::new,
            CODEC,
            DataFixTypes.SAVED_DATA_COMMAND_STORAGE);

    private final Long2LongOpenHashMap chunks = new Long2LongOpenHashMap();
    private final Long2LongOpenHashMap animals = new Long2LongOpenHashMap();
    private Long seen;
    private Long floor;

    Stamps() {}

    private Stamps(long seen, long floor, LongStream chunks, LongStream animals) {
        this.seen = seen == NEVER ? null : seen;
        this.floor = floor == NEVER ? null : floor;
        unflat(chunks, this.chunks);
        unflat(animals, this.animals);
    }

    private static void unflat(LongStream stream, Long2LongOpenHashMap into) {
        long[] flat = stream.toArray();
        for (int i = 0; i + 1 < flat.length; i += 2) into.put(flat[i], flat[i + 1]);
    }

    /** The game time the mod last saw the level at; null where it never has. */
    Long seen() {
        return seen;
    }

    /** The floor kept from an earlier start; null where none was set. */
    Long floor() {
        return floor;
    }

    void floorAt(long at) {
        if (at == NEVER) return;
        floor = at;
        setDirty();
    }

    void seenAt(long gameTime) {
        seen = gameTime;
        setDirty();
    }

    /** A chunk's stamp; null for one without. */
    Long of(long chunk) {
        return chunks.containsKey(chunk) ? chunks.get(chunk) : null;
    }

    /** A chunk's stamp for its animals; null for one without. */
    Long animalsOf(long chunk) {
        return animals.containsKey(chunk) ? animals.get(chunk) : null;
    }

    void keep(long chunk, long until, long animalsUntil) {
        chunks.put(chunk, until);
        animals.put(chunk, animalsUntil);
        setDirty();
    }

    private static LongStream flat(Long2LongOpenHashMap stamps) {
        long[] flat = new long[stamps.size() * 2];
        int i = 0;
        for (Long2LongOpenHashMap.Entry entry : stamps.long2LongEntrySet()) {
            flat[i++] = entry.getLongKey();
            flat[i++] = entry.getLongValue();
        }
        return LongStream.of(flat);
    }
}
