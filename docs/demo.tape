# The README demo: from a lesson to a rule an agent is given, on the starter KB.
# Render from the repo root with `vhs docs/demo.tape` (https://github.com/charmbracelet/vhs);
# it writes docs/demo.gif. No network and no model calls.

Output docs/demo.gif
Set FontSize 16
Set Width 1200
Set Height 720
Set Theme "Builtin Light"
Set TypingSpeed 35ms

Hide
Type "export KB=$(mktemp -d) && cp -R examples/starter-kb/. $KB && alias homeostat='node packages/cli/bin/homeostat.js' && clear"
Enter
Show

Type "# A reviewer's lesson becomes a team rule:"
Enter
Type `homeostat learn --dir $KB --author dana --area integrations --title "Use the v2 partner client" --rule "New partner code uses PartnerClientV2; v1 is being removed." --why "v1 blocks the event loop."`
Enter
Sleep 2s

Type "homeostat validate $KB"
Enter
Sleep 1.5s

Type "# Once a reviewer accepts it, every agent can search it and see why it exists:"
Enter
Type "homeostat search 'retry partner calls' --dir $KB"
Enter
Sleep 2.5s

Type "homeostat explain outbound-http-retry-helper --dir $KB | head -8"
Enter
Sleep 3s

Type "# And a security review in one command:"
Enter
Type "homeostat doctor --security --dir $KB | head -14"
Enter
Sleep 4s
