// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static java.net.HttpURLConnection.HTTP_OK;
import static java.net.HttpURLConnection.HTTP_MULT_CHOICE;
import static java.net.HttpURLConnection.HTTP_UNAVAILABLE;

import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
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

    @Test
    void anExpiredDeadlineKeepsEventsForTheNextFlush() {
        List<Integer> sent = new CopyOnWriteArrayList<>();
        Queue queue = new Queue((body, timeout) -> sent.add(sizeOf(body)), Duration.ofHours(1));
        queue.offer(Events.event("login", AT, null, null, null));
        queue.flush(Instant.MIN);
        assertEquals(List.of(), sent);
        queue.flush(Instant.MAX);
        assertEquals(List.of(1), sent);
    }

    @Test
    void aTransientFailureRetriesTheSameBatchWithoutDuplicatingLaterBatches() {
        List<String> sent = new CopyOnWriteArrayList<>();
        Queue queue = new Queue((body, timeout) -> {
            sent.add(body);
            assertTrue(timeout.isPositive());
            assertTrue(timeout.compareTo(Duration.ofSeconds(1)) <= 0);
            return sent.size() != 1;
        }, Duration.ofHours(1));
        for (int i = 0; i <= Queue.MOST_PER_BATCH; i++)
            queue.offer(Events.event("login", AT, null, "player-" + i, null));
        queue.flush(Instant.now().plusSeconds(1));
        assertEquals(3, sent.size());
        assertEquals(sent.get(0), sent.get(1));
        assertEquals(Queue.MOST_PER_BATCH, sizeOf(sent.get(1)));
        assertEquals(1, sizeOf(sent.get(2)));
        assertEquals("player-" + Queue.MOST_PER_BATCH, JsonParser.parseString(sent.get(2))
                .getAsJsonObject().getAsJsonArray("events").get(0).getAsJsonObject().get("name").getAsString());
    }

    @Test
    void stoppingWakesASleepingWorkerAndFlushesWithoutWaitingForItsInterval() throws InterruptedException {
        List<Integer> sent = new CopyOnWriteArrayList<>();
        Queue queue = new Queue((body, timeout) -> sent.add(sizeOf(body)), Duration.ofHours(1));
        var existing = Thread.getAllStackTraces().keySet();
        queue.start();
        try {
            Thread worker = Thread.getAllStackTraces().keySet().stream()
                    .filter(thread -> !existing.contains(thread) && thread.getName().equals("Cubepals reporter"))
                    .findFirst().orElseThrow();
            assertTrue(worker.isDaemon(), "reporting must not keep a server process alive");
            Instant readyBy = Instant.now().plusSeconds(2);
            while (worker.getState() != Thread.State.TIMED_WAITING && Instant.now().isBefore(readyBy))
                Thread.sleep(1);
            assertEquals(Thread.State.TIMED_WAITING, worker.getState());
            queue.offer(Events.event("left", AT, null, null, null));
            Instant began = Instant.now();
            queue.stop(Duration.ofSeconds(2));
            assertTrue(Duration.between(began, Instant.now()).toMillis() < 1_000);
            assertFalse(worker.isAlive(), "stop must join the worker before returning");
            assertEquals(List.of(1), sent);
        } finally {
            queue.stop(Duration.ofMillis(100));
        }
    }

    @Test
    void httpRequiresSuccessfulStatusAndPreservesTheRequest() throws java.io.IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger status = new AtomicInteger(HTTP_OK);
        List<String> received = new CopyOnWriteArrayList<>();
        server.createContext("/events", exchange -> {
            received.add(exchange.getRequestMethod());
            received.add(exchange.getRequestHeaders().getFirst("content-type"));
            received.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            exchange.sendResponseHeaders(status.get(), -1);
            exchange.close();
        });
        server.start();
        try {
            var sender = Queue.http(URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/events"));
            String batch = Events.batch(List.of(Events.event("left", AT, null, null, null)));
            for (var response : List.of(Map.entry(HTTP_OK, true), Map.entry(HTTP_MULT_CHOICE - 1, true),
                    Map.entry(HTTP_MULT_CHOICE, false), Map.entry(HTTP_UNAVAILABLE, false))) {
                status.set(response.getKey());
                assertEquals(response.getValue(), sender.send(batch, Duration.ofSeconds(5)),
                        "HTTP status " + response.getKey());
            }
            assertEquals(12, received.size());
            for (int i = 0; i < received.size(); i += 3) {
                assertEquals("POST", received.get(i));
                assertEquals("application/json", received.get(i + 1));
                assertEquals(batch, received.get(i + 2));
            }
            Thread.currentThread().interrupt();
            try {
                assertFalse(sender.send(batch, Duration.ofSeconds(1)));
                assertTrue(Thread.currentThread().isInterrupted());
            } finally {
                Thread.interrupted();
            }
            server.stop(0);
            assertFalse(sender.send(batch, Duration.ofMillis(100)));
        } finally {
            server.stop(0);
        }
    }
}
