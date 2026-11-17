// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression.mixin;

import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** A brewing stand's brew left, which `Cooking` reads to see whether it still has work. */
@Mixin(BrewingStandBlockEntity.class)
public interface BrewingAccess {
    @Accessor("brewTime")
    int cubepals$brewing();
}
