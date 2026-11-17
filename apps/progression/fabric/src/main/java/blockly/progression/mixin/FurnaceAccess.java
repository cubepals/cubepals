// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression.mixin;

import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** A furnace's fuel left and progress, which `Cooking` reads to see whether it still has work. */
@Mixin(AbstractFurnaceBlockEntity.class)
public interface FurnaceAccess {
    @Accessor("litTimeRemaining")
    int cubepals$lit();

    @Accessor("litTimeRemaining")
    void cubepals$setLit(int ticks);

    @Accessor("cookingTimer")
    int cubepals$cooking();
}
