// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression.mixin;

import blockly.progression.FabricProgression;
import java.util.function.BooleanSupplier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProgressListener;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Where the mod meets a level: each chunk the game ticks, the end of each tick, a chunk unloading,
 * and the level saving. All the work is `FabricProgression`'s.
 */
@Mixin(ServerLevel.class)
abstract class ServerLevelMixin {
    @Inject(method = "tickChunk", at = @At("HEAD"))
    private void cubepals$ticked(LevelChunk chunk, int randomTickSpeed, CallbackInfo info) {
        FabricProgression.ticked((ServerLevel) (Object) this, chunk);
    }

    @Inject(method = "tick", at = @At("TAIL"))
    private void cubepals$tickEnd(BooleanSupplier haveTime, CallbackInfo info) {
        FabricProgression.tickEnd((ServerLevel) (Object) this);
    }

    @Inject(method = "unload", at = @At("HEAD"))
    private void cubepals$unloading(LevelChunk chunk, CallbackInfo info) {
        FabricProgression.unloading((ServerLevel) (Object) this, chunk);
    }

    @Inject(method = "save", at = @At("HEAD"))
    private void cubepals$saving(ProgressListener progress, boolean flush, boolean skip, CallbackInfo info) {
        FabricProgression.saving((ServerLevel) (Object) this);
    }
}
