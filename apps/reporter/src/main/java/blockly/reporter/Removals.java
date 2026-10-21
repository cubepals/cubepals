// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import com.google.gson.JsonObject;
import java.time.Instant;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Function;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.entity.Player;

/**
 * `cubepals-remove <player> <reason>`: Stop cheaters' removal, which Grim's punishments run from the
 * console. It kicks the player with words they can read, saying they can rejoin, and queues a
 * `removed` event for the control plane, which keeps it for the server's Players page and bans a
 * player who keeps sending what no game can. Only the console may run it: not a player, an operator
 * or the remote console.
 */
final class Removals implements CommandExecutor {
    /** What each reason tells the player, as `REMOVAL_MESSAGES` in packages/contracts/src/stop-cheaters.ts. */
    static final Map<String, String> MESSAGES = Map.of(
            "movement", "Removed for moving in a way the game can’t. You can rejoin.",
            "speed", "Removed for moving faster than the game allows. You can rejoin.",
            "impossible", "Removed for sending something the game can’t. You can rejoin.");

    /** Where removals are queued; null where the server reports nowhere, and only kicks. */
    private final Consumer<JsonObject> queue;
    /** Who is online by name: the server's own players, or a test's. */
    private final Function<String, Player> online;

    Removals(Consumer<JsonObject> queue) {
        this(queue, Bukkit::getPlayerExact);
    }

    Removals(Consumer<JsonObject> queue, Function<String, Player> online) {
        this.queue = queue;
        this.online = online;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof ConsoleCommandSender)) {
            sender.sendMessage("Only the server's console can remove players this way.");
            return true;
        }
        if (args.length != 2 || !MESSAGES.containsKey(args[1])) {
            sender.sendMessage("Usage: cubepals-remove <player> <movement|speed|impossible>");
            return true;
        }
        Player player = online.apply(args[0]);
        if (player == null) return true;
        remove(player, args[1]);
        return true;
    }

    /** Kicks `player` for `reason`, and queues it. */
    void remove(Player player, String reason) {
        if (queue != null) queue.accept(Events.removed(Instant.now(), player.getUniqueId(), player.getName(), reason));
        player.kick(Component.text(MESSAGES.get(reason)));
    }
}
