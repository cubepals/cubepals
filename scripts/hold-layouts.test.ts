// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hold's layouts, read from `javap -c -p` of the game's own classes. Each listing below is the
 * declarations and the instructions that matter of what `javap` printed for that release's server
 * jar: 26.4-snapshot-10, 26.3, and 1.21.11, obfuscated, with the lines of Mojang's mappings for it
 * that name what it uses.
 */
import { expect, test } from 'bun:test'
import { layoutsOf, Mappings, PACKETS, paramsOf, stepsOf } from './hold-layouts.ts'

const LOGIN_FINISHED_26_4 = `public final class net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket extends java.lang.Record {
  public static final net.minecraft.network.codec.StreamCodec<io.netty.buffer.ByteBuf, net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket> STREAM_CODEC;
  public net.minecraft.network.protocol.PacketType<net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket> type();
       0: getstatic     #17                 // Field net/minecraft/network/protocol/login/LoginPacketTypes.CLIENTBOUND_LOGIN_FINISHED:Lnet/minecraft/network/protocol/PacketType;
  static {};
       0: getstatic     #49                 // Field net/minecraft/network/codec/ByteBufCodecs.GAME_PROFILE:Lnet/minecraft/network/codec/StreamCodec;
       8: getstatic     #59                 // Field net/minecraft/core/UUIDUtil.STREAM_CODEC:Lnet/minecraft/network/codec/StreamCodec;
      16: getstatic     #65                 // Field net/minecraft/network/protocol/login/ConnectionOptionsPacket.FLAG_FIELD_STREAM_CODEC:Lnet/minecraft/network/codec/StreamCodec;
      29: invokestatic  #74                 // InterfaceMethod net/minecraft/network/codec/StreamCodec.composite:(Lnet/minecraft/network/codec/StreamCodec;Ljava/util/function/Function;Lnet/minecraft/network/codec/StreamCodec;Ljava/util/function/Function;Lnet/minecraft/network/codec/StreamCodec;Ljava/util/function/Function;Lcom/mojang/datafixers/util/Function3;)Lnet/minecraft/network/codec/StreamCodec;
      32: putstatic     #80                 // Field STREAM_CODEC:Lnet/minecraft/network/codec/StreamCodec;
}`

const TRANSFER_26_4 = `public final class net.minecraft.network.protocol.common.ClientboundTransferPacket extends java.lang.Record {
  static {};
       0: getstatic     #49                 // Field net/minecraft/network/codec/ByteBufCodecs.STRING_UTF8:Lnet/minecraft/network/codec/StreamCodec;
       8: getstatic     #59                 // Field net/minecraft/network/codec/ByteBufCodecs.VAR_INT:Lnet/minecraft/network/codec/StreamCodec;
      21: getstatic     #49                 // Field net/minecraft/network/codec/ByteBufCodecs.STRING_UTF8:Lnet/minecraft/network/codec/StreamCodec;
      24: getstatic     #49                 // Field net/minecraft/network/codec/ByteBufCodecs.STRING_UTF8:Lnet/minecraft/network/codec/StreamCodec;
      27: invokestatic  #66                 // InterfaceMethod net/minecraft/network/codec/ByteBufCodecs.map:(Ljava/util/function/IntFunction;Lnet/minecraft/network/codec/StreamCodec;Lnet/minecraft/network/codec/StreamCodec;)Lnet/minecraft/network/codec/StreamCodec;
      40: invokestatic  #74                 // InterfaceMethod net/minecraft/network/codec/StreamCodec.composite:(Lnet/minecraft/network/codec/StreamCodec;Ljava/util/function/Function;Lnet/minecraft/network/codec/StreamCodec;Ljava/util/function/Function;Lnet/minecraft/network/codec/StreamCodec;Ljava/util/function/Function;Lcom/mojang/datafixers/util/Function3;)Lnet/minecraft/network/codec/StreamCodec;
}`

const LOGIN_FINISHED_26_3 = `public final class net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket extends java.lang.Record {
  static {};
       0: getstatic     #45                 // Field net/minecraft/network/codec/ByteBufCodecs.GAME_PROFILE:Lnet/minecraft/network/codec/StreamCodec;
       8: getstatic     #55                 // Field net/minecraft/core/UUIDUtil.STREAM_CODEC:Lnet/minecraft/network/codec/StreamCodec;
      21: invokestatic  #64                 // InterfaceMethod net/minecraft/network/codec/StreamCodec.composite:(Lnet/minecraft/network/codec/StreamCodec;Ljava/util/function/Function;Lnet/minecraft/network/codec/StreamCodec;Ljava/util/function/Function;Ljava/util/function/BiFunction;)Lnet/minecraft/network/codec/StreamCodec;
}`

const TRANSFER_26_3 = `public final class net.minecraft.network.protocol.common.ClientboundTransferPacket extends java.lang.Record {
  private net.minecraft.network.protocol.common.ClientboundTransferPacket(net.minecraft.network.FriendlyByteBuf);
       2: invokevirtual #17                 // Method net/minecraft/network/FriendlyByteBuf.readUtf:()Ljava/lang/String;
       6: invokevirtual #23                 // Method net/minecraft/network/FriendlyByteBuf.readVarInt:()I
  private void write(net.minecraft.network.FriendlyByteBuf);
       5: invokevirtual #30                 // Method net/minecraft/network/FriendlyByteBuf.writeUtf:(Ljava/lang/String;)Lnet/minecraft/network/FriendlyByteBuf;
      14: invokevirtual #34                 // Method net/minecraft/network/FriendlyByteBuf.writeVarInt:(I)Lnet/minecraft/network/FriendlyByteBuf;
  public net.minecraft.network.protocol.PacketType<net.minecraft.network.protocol.common.ClientboundTransferPacket> type();
       0: getstatic     #38                 // Field net/minecraft/network/protocol/common/CommonPacketTypes.CLIENTBOUND_TRANSFER:Lnet/minecraft/network/protocol/PacketType;
  static {};
      10: invokestatic  #74                 // InterfaceMethod net/minecraft/network/protocol/Packet.codec:(Lnet/minecraft/network/codec/StreamMemberEncoder;Lnet/minecraft/network/codec/StreamDecoder;)Lnet/minecraft/network/codec/StreamCodec;
}`

const MAPPINGS_1_21_11 = `# {"fileName":"server.txt"}
net.minecraft.network.codec.ByteBufCodecs -> aam:
    net.minecraft.network.codec.StreamCodec GAME_PROFILE_PROPERTIES -> y
    net.minecraft.network.codec.StreamCodec GAME_PROFILE -> A
net.minecraft.network.codec.StreamCodec -> aao:
net.minecraft.network.protocol.Packet -> aay:
net.minecraft.network.protocol.PacketType -> aba:
net.minecraft.network.FriendlyByteBuf -> wx:
    524:524:int readVarInt() -> l
    550:551:net.minecraft.network.FriendlyByteBuf writeVarInt(int) -> c
    605:605:java.lang.String readUtf() -> p
    613:613:net.minecraft.network.FriendlyByteBuf writeUtf(java.lang.String) -> a
    1403:1404:net.minecraft.network.FriendlyByteBuf writeByte(int) -> l
net.minecraft.network.protocol.login.ClientboundLoginFinishedPacket -> akt:
    com.mojang.authlib.GameProfile gameProfile -> b
    net.minecraft.network.codec.StreamCodec STREAM_CODEC -> a
net.minecraft.network.protocol.common.ClientboundTransferPacket -> abs:
    net.minecraft.network.codec.StreamCodec STREAM_CODEC -> a
    15:16:void <init>(net.minecraft.network.FriendlyByteBuf) -> <init>
    19:21:void write(net.minecraft.network.FriendlyByteBuf) -> a
`

const LOGIN_FINISHED_1_21_11 = `public final class akt extends java.lang.Record implements aay<ako> {
  public static final aao<io.netty.buffer.ByteBuf, akt> a;
  public aba<akt> a();
       0: getstatic     #35                 // Field aku.b:Laba;
  static {};
       0: getstatic     #80                 // Field aam.A:Laao;
      13: invokestatic  #109                // InterfaceMethod aao.a:(Laao;Ljava/util/function/Function;Ljava/util/function/Function;)Laao;
}`

const TRANSFER_1_21_11 = `public final class abs extends java.lang.Record implements aay<abg> {
  private abs(wx);
       2: invokevirtual #28                 // Method wx.p:()Ljava/lang/String;
       6: invokevirtual #32                 // Method wx.l:()I
  private void a(wx);
       5: invokevirtual #50                 // Method wx.a:(Ljava/lang/String;)Lwx;
      14: invokevirtual #53                 // Method wx.c:(I)Lwx;
  public aba<abs> a();
       0: getstatic     #60                 // Field abu.l:Laba;
  static {};
      10: invokestatic  #129                // InterfaceMethod aay.a:(Laar;Laap;)Laao;
}`

const listing = (classes: Record<string, string>) => (className: string) => {
  const found = classes[className]
  if (found === undefined) throw new Error(`no class ${className}`)
  return found
}

test('26.4 writes a session uuid and its options after the profile, and query properties in a transfer', () => {
  const javap = listing({ [PACKETS.loginFinished]: LOGIN_FINISHED_26_4, [PACKETS.transfer]: TRANSFER_26_4 })
  expect(layoutsOf(javap, Mappings.NONE)).toEqual({
    loginFinished: 'profile+session+options',
    transfer: 'host+port+properties',
  })
})

test('26.3 writes a session uuid after the profile, and a transfer that writes itself, host then port', () => {
  const javap = listing({ [PACKETS.loginFinished]: LOGIN_FINISHED_26_3, [PACKETS.transfer]: TRANSFER_26_3 })
  expect(layoutsOf(javap, Mappings.NONE)).toEqual({ loginFinished: 'profile+session', transfer: 'host+port' })
})

test('an obfuscated release is read through its mappings: 1.21.11 writes the profile alone', () => {
  const mappings = new Mappings(MAPPINGS_1_21_11)
  expect(mappings.classFor(PACKETS.loginFinished)).toBe('akt')
  const javap = listing({ akt: LOGIN_FINISHED_1_21_11, abs: TRANSFER_1_21_11 })
  expect(layoutsOf(javap, mappings)).toEqual({ loginFinished: 'profile', transfer: 'host+port' })
})

test('only the codecs a packet is built from, and its own writes, are its steps', () => {
  // Its packet type, its reads and the codec it builds are not.
  expect(stepsOf(TRANSFER_26_3, PACKETS.transfer, Mappings.NONE)).toEqual([
    'FriendlyByteBuf.writeUtf',
    'FriendlyByteBuf.writeVarInt',
  ])
  expect(stepsOf(TRANSFER_1_21_11, 'abs', new Mappings(MAPPINGS_1_21_11))).toEqual([
    'FriendlyByteBuf.writeUtf',
    'FriendlyByteBuf.writeVarInt',
  ])
})

test('a layout the edge can’t write is refused, naming the packet and how it is written', () => {
  const more = LOGIN_FINISHED_26_4.replace(
    '      29: invokestatic',
    '      26: getstatic     #90                 // Field net/minecraft/network/codec/ByteBufCodecs.BOOL:Lnet/minecraft/network/codec/StreamCodec;\n      29: invokestatic',
  )
  const javap = listing({ [PACKETS.loginFinished]: more, [PACKETS.transfer]: TRANSFER_26_4 })
  expect(() => layoutsOf(javap, Mappings.NONE)).toThrow(
    `${PACKETS.loginFinished} is written as [ByteBufCodecs.GAME_PROFILE UUIDUtil.STREAM_CODEC ConnectionOptionsPacket.FLAG_FIELD_STREAM_CODEC ByteBufCodecs.BOOL], a layout the edge's dialog hold can't write`,
  )
  const nothing = listing({ [PACKETS.loginFinished]: LOGIN_FINISHED_26_3, [PACKETS.transfer]: '' })
  expect(() => layoutsOf(nothing, Mappings.NONE)).toThrow(`${PACKETS.transfer} is written as []`)
})

test('a descriptor’s parameters are named as Java names them', () => {
  expect(paramsOf('(Ljava/lang/String;I)Lwx;')).toEqual(['java.lang.String', 'int'])
  expect(paramsOf('([B[[Lwx;JZ)V')).toEqual(['byte[]', 'wx[][]', 'long', 'boolean'])
  expect(paramsOf('()I')).toEqual([])
})
