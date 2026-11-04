// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** How the clock hands samples to the main thread: one waiting at a time, whatever the clock does. */
class VitalsTest {
    @Test
    void aMinuteHandsOneSampleOverAndNoMoreWhileItWaits() {
        List<Runnable> handed = new ArrayList<>();
        Runnable minute = new Vitals(event -> {}).onTheMinute(handed::add);
        minute.run();
        minute.run();
        minute.run();
        // A main thread stalled for three minutes has one sample waiting, not three.
        assertEquals(1, handed.size());
    }

    @Test
    void theNextMinuteHandsAnotherOnceTheLastRan() {
        List<Runnable> handed = new ArrayList<>();
        Runnable minute = new Vitals(event -> {}).onTheMinute(handed::add);
        minute.run();
        // Running it reads Bukkit, absent here; it lets the next one go all the same.
        try {
            handed.get(0).run();
        } catch (RuntimeException | LinkageError e) {
            // Bukkit isn't running in a test.
        }
        minute.run();
        assertEquals(2, handed.size());
    }

    @Test
    void aMinuteTheServerRefusesLetsTheNextOneTry() {
        List<Runnable> handed = new ArrayList<>();
        boolean[] refuse = {true};
        Runnable minute = new Vitals(event -> {}).onTheMinute(task -> {
            if (refuse[0]) throw new IllegalStateException("plugin disabled");
            handed.add(task);
        });
        minute.run();
        refuse[0] = false;
        minute.run();
        assertEquals(1, handed.size());
    }
}
