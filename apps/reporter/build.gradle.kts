// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

// Built with JDK 21 for Java 17's bytecode: Paper 1.20.1, the oldest Cubepals offers, runs on 17.
// Compiled against that Paper's API, so it loads on every Paper Cubepals offers; the events only
// newer Paper has are found by name as it starts (Listeners.java).

plugins {
    java
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.20.1-R0.1-SNAPSHOT")
    // The tests run against a Paper that has the configuration events, built for Java 21.
    testImplementation("io.papermc.paper:paper-api:1.21.8-R0.1-SNAPSHOT")
    testImplementation(platform("org.junit:junit-bom:5.13.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}

tasks.compileJava {
    options.release = 17
}

tasks.compileTestJava {
    options.release = 21
}

tasks.test {
    useJUnitPlatform()
}

// The same bytes from the same source, so the control plane stores one copy by its digest.
tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

tasks.jar {
    archiveFileName = "cubepals-reporter.jar"
}
