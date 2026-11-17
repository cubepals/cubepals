// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// Offline world progression: what catches furnaces and plants up on the time their chunks weren't
// ticked. `reckoning` is what both reckon with (the clock, random ticks, the budget), with its
// tests; `paper` is the Paper plugin, `fabric` the Fabric mod.
pluginManagement {
    repositories {
        maven("https://maven.fabricmc.net/")
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = "progression"
include("reckoning", "paper", "fabric")
