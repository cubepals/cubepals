// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import com.google.gson.JsonObject;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;

/**
 * What the reporter has to send, sent by one thread of its own a batch at a time, so no event a
 * player causes ever waits on the network. A full queue drops what comes; a batch the control
 * plane doesn't take in three tries is dropped too. Nothing here can slow the server's tick.
 */
final class Queue {
    static final int MOST_QUEUED = 500;
    static final int MOST_PER_BATCH = 200;
    static final int TRIES = 3;
    private static final Duration TIMEOUT = Duration.ofSeconds(5);

    /** Sends one body; whether it was taken. Gives up by `timeout`. */
    interface Sender {
        boolean send(String body, Duration timeout);
    }

    private final ArrayBlockingQueue<JsonObject> events = new ArrayBlockingQueue<>(MOST_QUEUED);
    private final Sender sender;
    private final Duration every;
    private final Thread thread;
    private volatile boolean running = true;

    Queue(Sender sender, Duration every) {
        this.sender = sender;
        this.every = every;
        this.thread = new Thread(this::run, "Cubepals reporter");
        this.thread.setDaemon(true);
    }

    /** Queues an event; false, and it is dropped, when the queue is full. Never blocks. */
    boolean offer(JsonObject event) {
        return events.offer(event);
    }

    void start() {
        thread.start();
    }

    /** Stops the thread, then sends what is left, for no longer than `limit` in all. */
    void stop(Duration limit) {
        Instant deadline = Instant.now().plus(limit);
        running = false;
        thread.interrupt();
        try {
            thread.join(limit.toMillis());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        flush(deadline);
    }

    /** Sends every queued event, a batch at a time, until `deadline`. */
    void flush(Instant deadline) {
        while (!events.isEmpty() && Instant.now().isBefore(deadline)) {
            List<JsonObject> batch = new ArrayList<>(MOST_PER_BATCH);
            events.drainTo(batch, MOST_PER_BATCH);
            String body = Events.batch(batch);
            for (int tried = 0; tried < TRIES && Instant.now().isBefore(deadline); tried++) {
                Duration left = Duration.between(Instant.now(), deadline);
                if (sender.send(body, left.compareTo(TIMEOUT) < 0 ? left : TIMEOUT)) break;
            }
        }
    }

    private void run() {
        while (running) {
            try {
                Thread.sleep(every.toMillis());
            } catch (InterruptedException e) {
                return;
            }
            flush(Instant.MAX);
        }
    }

    /** Posts each body to `url` as JSON. */
    static Sender http(URI url) {
        HttpClient client = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
        return (body, timeout) -> {
            HttpRequest request = HttpRequest.newBuilder(url)
                    .timeout(timeout)
                    .header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            try {
                int status = client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
                return status >= 200 && status < 300;
            } catch (java.io.IOException e) {
                return false;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        };
    }
}
