// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** The queue: bounded, batched, tried three times, and flushed on the way out. */
class QueueTest {
    private static final Instant AT = Instant.parse("2026-10-20T10:00:00Z");

    private static int sizeOf(String body) {
        return JsonParser.parseString(body).getAsJsonObject().getAsJsonArray("events").size();
    }

    @Test
    void aFullQueueDropsWhatComesAndNeverBlocks() {
        Queue queue = new Queue((body, timeout) -> true, Duration.ofHours(1));
        for (int i = 0; i < Queue.MOST_QUEUED; i++) assertTrue(queue.offer(Events.event("login", AT, null, null, null)));
        assertFalse(queue.offer(Events.event("login", AT, null, null, null)));
    }

    @Test
    void sendsInBatchesOfAtMost200() {
        List<Integer> sent = new CopyOnWriteArrayList<>();
        Queue queue = new Queue((body, timeout) -> sent.add(sizeOf(body)), Duration.ofHours(1));
        for (int i = 0; i < 450; i++) queue.offer(Events.event("login", AT, null, null, null));
        queue.flush(Instant.MAX);
        assertEquals(List.of(200, 200, 50), sent);
    }

    @Test
    void aBatchNotTakenIsTriedThreeTimesThenDropped() {
        AtomicInteger tries = new AtomicInteger();
        Queue queue = new Queue((body, timeout) -> tries.incrementAndGet() < 0, Duration.ofHours(1));
        queue.offer(Events.event("left", AT, null, null, null));
        queue.flush(Instant.MAX);
        queue.flush(Instant.MAX);
        assertEquals(Queue.TRIES, tries.get());
    }

    @Test
    void itsThreadSendsOnItsOwnAndStoppingSendsTheRest() throws InterruptedException {
        List<Integer> sent = new CopyOnWriteArrayList<>();
        Queue queue = new Queue((body, timeout) -> sent.add(sizeOf(body)), Duration.ofMillis(20));
        queue.start();
        queue.offer(Events.event("login", AT, null, null, null));
        for (int waited = 0; sent.isEmpty() && waited < 2_000; waited += 10) Thread.sleep(10);
        assertEquals(List.of(1), sent);
        queue.stop(Duration.ofSeconds(2));
        queue.offer(Events.event("left", AT, null, null, null));
        queue.stop(Duration.ofSeconds(2));
        assertEquals(List.of(1, 1), sent);
    }

    @Test
    void stoppingGivesUpAtItsLimit() {
        Queue queue = new Queue((body, timeout) -> false, Duration.ofHours(1));
        queue.offer(Events.event("left", AT, null, null, null));
        Instant began = Instant.now();
        queue.stop(Duration.ofMillis(200));
        assertTrue(Duration.between(began, Instant.now()).toMillis() < 1_000);
    }
}
