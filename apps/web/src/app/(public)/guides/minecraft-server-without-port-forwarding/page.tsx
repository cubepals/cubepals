/**
 * The guide to hosting a Minecraft server without port forwarding. The router and CGNAT facts come
 * from the Minecraft Wiki, minecraft.net and RFC 6598, and playit.gg is described from its own
 * page, all linked; the joining was done on a local stack.
 */
import type { Metadata } from 'next'
import { GuideArticle, GuideLink, guideMetadata, Part, Questions, Shot } from '../article'

const SLUG = 'minecraft-server-without-port-forwarding'

export const generateMetadata = (): Metadata => guideMetadata(SLUG)

export default function Guide() {
  return (
    <GuideArticle slug={SLUG}>
      <p className="type-body">
        You’ve started a Minecraft: Java Edition server on your computer, it works for you, and your friends
        can’t get in. Usually the problem is between your computer and the internet, not in Minecraft.
      </p>

      <Part id="why" title="Why friends can’t join a server on your computer">
        <p>
          Your router lets your computer reach the internet, but it doesn’t let the internet reach your
          computer unless you tell it to. For a Minecraft server that means forwarding a port: the{' '}
          <a href="https://minecraft.wiki/w/Tutorial:Setting_up_a_Java_Edition_server">
            Minecraft Wiki’s server tutorial
          </a>{' '}
          says you “must port forward for someone outside your network to connect to the server”, and a Java
          server listens on port 25565 by default. Every router hides the setting somewhere different.
        </p>
        <p>
          Sometimes it can’t work at all. Many internet providers share one public address between lots of
          homes, which is called carrier-grade NAT, or CGNAT. Then the router you can change isn’t the one
          facing the internet. The standard that set aside addresses for it,{' '}
          <a href="https://www.rfc-editor.org/rfc/rfc6598.txt">RFC 6598</a>, notes that some applications
          “cannot seed content due to the inability to open incoming ports through the CGN”. If your router
          shows an internet address starting with 100.64 to 100.127, this is probably you.
        </p>
      </Part>

      <Part id="ways-around" title="The ways around it">
        <ul>
          <li>
            <strong>A tunnel.</strong> <a href="https://playit.gg/">playit.gg</a> calls itself “a global proxy
            that lets you host a server without port forwarding”. You run its program next to your server, and
            friends join an address it gives you. It has a free tier. Your computer still has to be on for
            anyone to play.
          </li>
          <li>
            <strong>A private network between you.</strong> Everyone installs the same app, which puts your
            computers on one network as if you were in the same house. It works, but every friend has to set
            it up, and your computer still has to be on.
          </li>
          <li>
            <strong>A server somewhere else.</strong> The world lives on a machine that’s always reachable, so
            there’s no router of yours involved and nobody’s computer has to stay on.
          </li>
        </ul>
      </Part>

      <Part id="nothing-to-open" title="A server with nothing to open">
        <p>
          On Cubepals there’s no port and no IP address to share. Your server gets one address made from its
          name, and your friends type it in. In Minecraft: Java Edition they open <strong>Multiplayer</strong>
          , then <strong>Add Server</strong>, and paste it. They join like any server. If it’s asleep, give it
          a minute.
        </p>
        <Shot
          src="/guides/minecraft-server-for-friends/address.png"
          width={576}
          height={202}
          alt="A Cubepals server’s page showing its address, maple-hollow.play.cubepals.com, with a Copy address button. There is no port number in it."
        />
        <p>
          <GuideLink to="minecraft-server-for-friends">Making a server for friends</GuideLink> shows the whole
          thing, and <GuideLink to="play-minecraft-java-with-friends">playing Java with friends</GuideLink>{' '}
          compares it with the ways that need no server.
        </p>
      </Part>

      <Questions
        items={[
          {
            question: 'Why can’t my friends join?',
            answer: (
              <>
                Check these, in order. Are they on Java Edition? Bedrock players, on phones and consoles,
                can’t join a Java server. Is their game on the same Minecraft version as the server? Did they
                paste the whole address, with nothing missing? If the server is on your own computer, is the
                port forwarded, and is your provider using CGNAT?
              </>
            ),
          },
        ]}
      />
    </GuideArticle>
  )
}
