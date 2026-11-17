// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// The Fabric mod, for Minecraft 26.3 on Java 25, which that release needs. It reaches the game
// through mixins under Mojang's own names (26.x is published unobfuscated), and asks for neither
// Fabric API nor anything of a player's game.
plugins {
    id("net.fabricmc.fabric-loom") version "1.19.4"
}

repositories {
    mavenCentral()
}

sourceSets.main {
    java.srcDir("../reckoning/src/main/java")
}

dependencies {
    minecraft("com.mojang:minecraft:26.3")
    implementation("net.fabricmc:fabric-loader:0.20.1")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release = 25
}

// The same bytes from the same source, so the control plane stores one copy by its digest.
tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

tasks.jar {
    archiveFileName = "cubepals-progression-fabric.jar"
}
