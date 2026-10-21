// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.command.RemoteConsoleCommandSender;
import org.bukkit.entity.Player;
import org.junit.jupiter.api.Test;

/**
 * Stop cheaters' `cubepals-remove`: the console alone may run it, each reason kicks with its own
 * words, and each removal is queued as a `removed` event. Senders and the player are stand-ins
 * answering only what is asked.
 */
class RemovalsTest {
    private static final UUID ALEX = UUID.fromString("6ab43178-89fd-4905-8c45-9f2f4ad1c2a5");

    /** A stand-in of `type` that records what it is told: messages sent, and the kick's words. */
    @SuppressWarnings("unchecked")
    private static <T> T standIn(Class<T> type, List<String> told) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "sendMessage" -> told.add(String.valueOf(args[0]));
                case "kick" -> told.add(PlainTextComponentSerializer.plainText().serialize((Component) args[0]));
                case "getUniqueId" -> {
                    return ALEX;
                }
                case "getName" -> {
                    return "Alex";
                }
                default -> {}
            }
            Class<?> returns = method.getReturnType();
            if (returns == boolean.class) return false;
            return null;
        });
    }

    private static boolean run(Removals removals, CommandSender sender, String... args) {
        return removals.onCommand(sender, null, "cubepals-remove", args);
    }

    @Test
    void anySenderButTheConsoleIsRefused() {
        List<JsonObject> queued = new ArrayList<>();
        List<String> kicked = new ArrayList<>();
        Removals removals = new Removals(queued::add, name -> standIn(Player.class, kicked));
        for (Class<? extends CommandSender> type : List.of(Player.class, RemoteConsoleCommandSender.class)) {
            List<String> told = new ArrayList<>();
            assertTrue(run(removals, standIn(type, told), "Alex", "speed"));
            assertEquals(List.of("Only the server's console can remove players this way."), told);
        }
        assertEquals(0, queued.size());
        assertEquals(0, kicked.size());
    }

    @Test
    void eachReasonKicksWithItsOwnWordsAndIsQueued() {
        List<JsonObject> queued = new ArrayList<>();
        List<String> kicked = new ArrayList<>();
        Removals removals = new Removals(queued::add, name -> standIn(Player.class, kicked));
        ConsoleCommandSender console = standIn(ConsoleCommandSender.class, new ArrayList<>());
        for (String reason : List.of("movement", "speed", "impossible")) run(removals, console, "Alex", reason);
        assertEquals(
                List.of(
                        "Removed for moving in a way the game can’t. You can rejoin.",
                        "Removed for moving faster than the game allows. You can rejoin.",
                        "Removed for sending something the game can’t. You can rejoin."),
                kicked);
        assertEquals(3, queued.size());
        JsonObject event = queued.get(2);
        assertEquals("removed", event.get("kind").getAsString());
        assertEquals(ALEX.toString(), event.get("uuid").getAsString());
        assertEquals("Alex", event.get("name").getAsString());
        assertEquals("impossible", event.get("reason").getAsString());
        assertTrue(event.get("at").getAsString().endsWith("Z"));
    }

    @Test
    void anUnknownReasonOrSomeoneOfflineRemovesNobody() {
        List<JsonObject> queued = new ArrayList<>();
        List<String> told = new ArrayList<>();
        ConsoleCommandSender console = standIn(ConsoleCommandSender.class, told);
        run(new Removals(queued::add, name -> standIn(Player.class, new ArrayList<>())), console, "Alex", "flying");
        assertEquals(List.of("Usage: cubepals-remove <player> <movement|speed|impossible>"), told);
        run(new Removals(queued::add, name -> null), console, "Alex", "speed");
        assertEquals(0, queued.size());
    }
}
