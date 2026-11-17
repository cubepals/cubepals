// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// The Paper plugin, for Java 17's bytecode: Paper 1.20.1, the oldest Cubepals offers, runs on 17.
// Compiled against that Paper's API, so it loads on every Paper Cubepals offers; the furnace tick,
// which Paper's API doesn't offer, is found by name as it starts (Smelting.java).
plugins {
    java
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

sourceSets.main {
    java.srcDir("../reckoning/src/main/java")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.20.1-R0.1-SNAPSHOT")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
    options.release = 17
}

// The same bytes from the same source, so the control plane stores one copy by its digest.
tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

tasks.jar {
    archiveFileName = "cubepals-progression.jar"
}
