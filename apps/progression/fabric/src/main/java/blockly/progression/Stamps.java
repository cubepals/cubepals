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
 * last saw the level at (`Clock.floor`), kept as the level's own saved data, which Minecraft writes
 * with the level each time it saves: sixteen bytes a chunk the mod has seen ticked.
 */
final class Stamps extends SavedData {
    /** `seen` for a level the mod never saw. */
    private static final long NEVER = Long.MIN_VALUE;

    private static final Codec<Stamps> CODEC = RecordCodecBuilder.create(fields -> fields.group(
                    Codec.LONG.fieldOf("seen").forGetter(stamps -> stamps.seen == null ? NEVER : stamps.seen),
                    Codec.LONG_STREAM.fieldOf("chunks").forGetter(Stamps::flat))
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
    private Long seen;

    Stamps() {}

    private Stamps(long seen, LongStream stream) {
        this.seen = seen == NEVER ? null : seen;
        long[] flat = stream.toArray();
        for (int i = 0; i + 1 < flat.length; i += 2) chunks.put(flat[i], flat[i + 1]);
    }

    /** The game time the mod last saw the level at; null where it never has. */
    Long seen() {
        return seen;
    }

    void seenAt(long gameTime) {
        seen = gameTime;
        setDirty();
    }

    /** A chunk's stamp; null for one without. */
    Long of(long chunk) {
        return chunks.containsKey(chunk) ? chunks.get(chunk) : null;
    }

    void keep(long chunk, long until) {
        chunks.put(chunk, until);
        setDirty();
    }

    void forget(long chunk) {
        if (chunks.containsKey(chunk)) {
            chunks.remove(chunk);
            setDirty();
        }
    }

    private LongStream flat() {
        long[] flat = new long[chunks.size() * 2];
        int i = 0;
        for (Long2LongOpenHashMap.Entry entry : chunks.long2LongEntrySet()) {
            flat[i++] = entry.getLongKey();
            flat[i++] = entry.getLongValue();
        }
        return LongStream.of(flat);
    }
}
