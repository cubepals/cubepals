// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonParser;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The events as the control plane reads them. */
class EventsTest {
    private static final Instant AT = Instant.parse("2026-10-20T10:00:01.234567Z");
    private static final UUID STEVE = UUID.fromString("8667ba71-b85a-4004-af54-457a9734eed7");

    @Test
    void anEventSaysItsKindTimeAndPlayer() {
        var event = Events.event("login", AT, STEVE, "Steve", null);
        assertEquals(
                "{\"kind\":\"login\",\"at\":\"2026-10-20T10:00:01.234Z\",\"uuid\":\"" + STEVE + "\",\"name\":\"Steve\"}",
                event.toString());
    }

    @Test
    void anAddressIsIpAndPortWithIpv6InBrackets() {
        assertEquals("203.0.113.9:51234", Events.address(new InetSocketAddress("203.0.113.9", 51234)));
        assertEquals("[2001:db8:0:0:0:0:0:1]:25565", Events.address(new InetSocketAddress("2001:db8::1", 25565)));
        assertNull(Events.address(null));
    }

    @Test
    void aBootNamesPaperAndWhoListensAtLogin() {
        var boot = Events.boot(AT, "git-Paper-196", "1.20.1", List.of("OldAuth"), List.of());
        var read = JsonParser.parseString(Events.batch(List.of(boot))).getAsJsonObject();
        var detail = read.getAsJsonArray("events").get(0).getAsJsonObject().getAsJsonObject("detail");
        assertEquals("OldAuth", detail.getAsJsonArray("loginListeners").get(0).getAsString());
        assertEquals(0, detail.getAsJsonArray("configureListeners").size());
        assertEquals("1.20.1", detail.get("minecraft").getAsString());
    }

    @Test
    void aTickIsRounded() {
        assertEquals("{\"tps\":19.99,\"mspt\":12.35,\"online\":3}", Events.tick(19.98765, 12.3456, 3).toString());
    }
}
