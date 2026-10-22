#!/bin/sh
# A sizing load machine's entrypoint (size.ts). `server`: the stand-in control plane and a Java
# server that lets in players without accounts. `client`: nothing runs until it is told to.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
case "${1:-client}" in
server)
  cd /server
  echo 'eula=true' > eula.txt
  cat > server.properties <<PROPS
online-mode=false
server-port=25570
enforce-secure-profile=false
max-players=200
white-list=false
difficulty=peaceful
pause-when-empty-seconds=-1
spawn-monsters=false
spawn-animals=false
enforce-whitelist=false
view-distance=6
simulation-distance=4
level-type=minecraft\:flat
spawn-protection=0
PROPS
  bun "$here/control-stub.ts" &
  exec java -Xmx1200m -XX:+UseSerialGC -jar server.jar nogui
  ;;
*) exec sleep infinity ;;
esac
