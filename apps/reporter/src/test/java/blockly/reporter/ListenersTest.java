// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.destroystokyo.paper.profile.PlayerProfile;
import com.google.gson.JsonObject;
import io.papermc.paper.connection.PlayerConfigurationConnection;
import io.papermc.paper.connection.PlayerLoginConnection;
import io.papermc.paper.event.connection.PlayerConnectionValidateLoginEvent;
import io.papermc.paper.event.connection.configuration.PlayerConnectionInitialConfigureEvent;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The configuration events, read by name as on a Paper that has them: the events are Paper's own,
 * their connections and profiles stand-ins answering only what is asked.
 */
class ListenersTest {
    private static final UUID ALEX = UUID.fromString("6ab43178-89fd-4905-8c45-9f2f4ad1c2a5");

    @SuppressWarnings("unchecked")
    private static <T> T standIn(Class<T> type, java.util.Map<String, Object> answers) {
        return (T) Proxy.newProxyInstance(
                type.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> answers.get(method.getName()));
    }

    private static PlayerConfigurationConnection configuring() {
        PlayerProfile profile = standIn(PlayerProfile.class, java.util.Map.of("getId", ALEX, "getName", "Alex"));
        return standIn(
                PlayerConfigurationConnection.class,
                java.util.Map.of(
                        "getProfile", profile, "getClientAddress", new InetSocketAddress("198.51.100.4", 40001)));
    }

    @Test
    void theEventsItListensForByNameExistWhereTheyShould() {
        assertNotNull(Listeners.classNamed(Listeners.INITIAL_CONFIGURE));
        assertNotNull(Listeners.classNamed(Listeners.VALIDATE_LOGIN));
        assertNull(Listeners.classNamed("io.papermc.paper.event.NoSuchEvent"));
    }

    @Test
    void configurationStartingSaysWhoAndFromWhere() {
        List<JsonObject> queued = new ArrayList<>();
        new Listeners(queued::add)
                .configuration(new PlayerConnectionInitialConfigureEvent(configuring()), "configure_started");
        assertEquals(1, queued.size());
        JsonObject event = queued.get(0);
        assertEquals("configure_started", event.get("kind").getAsString());
        assertEquals(ALEX.toString(), event.get("uuid").getAsString());
        assertEquals("Alex", event.get("name").getAsString());
        assertEquals("198.51.100.4:40001", event.get("address").getAsString());
    }

    @Test
    void onlyTheSecondValidationTheOneAfterConfigurationCounts() {
        List<JsonObject> queued = new ArrayList<>();
        Listeners listeners = new Listeners(queued::add);
        PlayerLoginConnection loggingIn = standIn(PlayerLoginConnection.class, java.util.Map.of());
        listeners.configuration(new PlayerConnectionValidateLoginEvent(loggingIn, null), "configured");
        assertEquals(0, queued.size());
        listeners.configuration(new PlayerConnectionValidateLoginEvent(configuring(), null), "configured");
        assertEquals("configured", queued.get(0).get("kind").getAsString());
    }
}
