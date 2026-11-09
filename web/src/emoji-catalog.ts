// The full reaction picker's emoji: a hand-picked set by category, each with the words it is found by. Loaded only
// when the full picker opens (ReactionPicker.tsx imports it on demand), so the chat never carries it. Any other emoji
// can still be typed or pasted into the picker's own field.

export interface EmojiEntry {
  emoji: string;
  /** Words it is found by (its name first). Labels use the emoji itself: screen readers announce its own name. */
  words: string;
}

export interface EmojiCategory {
  name: string;
  emoji: EmojiEntry[];
}

// One line per emoji: the emoji, a space, its name and other words.
const SOURCE: Record<string, string> = {
  'Smileys': `
😀 grinning face smile happy
😃 grinning face big eyes smile happy
😄 grinning face smiling eyes laugh happy
😁 beaming face grin
😆 grinning squinting face laugh
😅 grinning face sweat relief phew
🤣 rolling on the floor laughing lol rofl
😂 face with tears of joy laugh lol funny
🙂 slightly smiling face
🙃 upside down face silly
😉 winking face wink
😊 smiling face blush happy
😇 smiling face halo angel innocent
🥰 smiling face hearts love adore
😍 heart eyes love
🤩 star struck wow amazing
😘 face blowing a kiss
😋 face savoring food yum tasty
😛 face with tongue
😜 winking face tongue playful
🤪 zany face crazy goofy
🤑 money mouth face rich
🤗 hugging face hug thanks
🤭 face with hand over mouth oops giggle
🤫 shushing face quiet secret
🤔 thinking face hmm think wonder
🫡 saluting face salute yes sir ok
🤐 zipper mouth face secret
🤨 face raised eyebrow skeptical doubt
😐 neutral face meh
😑 expressionless face
😶 face without mouth speechless
🫠 melting face embarrassed hot
😏 smirking face smug
😒 unamused face meh
🙄 face rolling eyes
😬 grimacing face awkward eek
😮‍💨 face exhaling sigh relief
😌 relieved face calm
😔 pensive face sad
😪 sleepy face
🤤 drooling face
😴 sleeping face tired zzz
😷 face with medical mask sick
🤒 face with thermometer sick ill
🤕 face with head bandage hurt
🤢 nauseated face sick gross
🤮 face vomiting gross
🥵 hot face heat sweating
🥶 cold face freezing
🥴 woozy face dizzy
😵 face with crossed out eyes dizzy
🤯 exploding head mind blown wow
🤠 cowboy hat face yeehaw
🥳 partying face party celebrate birthday
😎 smiling face sunglasses cool
🤓 nerd face geek
🧐 face with monocle inspect curious
😕 confused face unsure off
🫤 face with diagonal mouth unsure meh
😟 worried face concern
🙁 slightly frowning face sad
😮 face with open mouth surprised wow
😯 hushed face surprised
😲 astonished face shocked
😳 flushed face embarrassed
🥺 pleading face puppy eyes please
🥹 face holding back tears grateful touched
😦 frowning face open mouth
😧 anguished face
😨 fearful face scared
😰 anxious face sweat nervous
😥 sad but relieved face
😢 crying face sad tear
😭 loudly crying face sob
😱 face screaming in fear shock
😖 confounded face
😣 persevering face struggle
😞 disappointed face sad
😓 downcast face sweat
😩 weary face tired
😫 tired face exhausted
🥱 yawning face bored tired
😤 face with steam from nose triumph frustrated
😡 enraged face angry mad
😠 angry face mad
🤬 face with symbols on mouth swearing
😈 smiling face horns devil mischief
💀 skull dead lol
💩 pile of poo
🤡 clown face
👻 ghost boo
👽 alien
🤖 robot bot
😺 grinning cat
😻 smiling cat heart eyes love
🙈 see no evil monkey oops
🙉 hear no evil monkey
🙊 speak no evil monkey`,
  'People': `
👍 thumbs up yes ok good like approve agree
👎 thumbs down no bad dislike wrong disagree
👌 ok hand fine perfect
🤌 pinched fingers chef kiss
🤏 pinching hand tiny little
✌️ victory hand peace
🤞 crossed fingers luck hope
🫰 hand with index finger and thumb crossed
🤟 love you gesture
🤘 sign of the horns rock
🤙 call me hand shaka
👈 backhand index pointing left
👉 backhand index pointing right
👆 backhand index pointing up
👇 backhand index pointing down
☝️ index pointing up first
👋 waving hand hello hi bye wave
🤚 raised back of hand
🖐️ hand with fingers splayed
✋ raised hand high five stop
🖖 vulcan salute
👏 clapping hands applause bravo well done
🙌 raising hands hooray celebrate praise
🫶 heart hands love thanks
👐 open hands
🤲 palms up together
🤝 handshake deal agree
🙏 folded hands please thanks thank you pray
✍️ writing hand write
💪 flexed biceps strong strength
🧠 brain smart think
👀 eyes look watching seen on it
👁️ eye
👂 ear listen
🫂 people hugging hug support
🗣️ speaking head talk
🤷 person shrugging shrug dunno whatever
🤦 person facepalming facepalm
🙋 person raising hand me question
🙆 person gesturing ok
🙅 person gesturing no
💁 person tipping hand
🙇 person bowing sorry thanks
🧑‍💻 technologist coder developer programmer
🕵️ detective investigate
🧙 mage wizard magic
🦸 superhero hero
🏃 person running run hurry
💃 woman dancing dance celebrate
🕺 man dancing dance`,
  'Hearts': `
❤️ red heart love like
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🤎 brown heart
🖤 black heart
🤍 white heart
🩷 pink heart
💖 sparkling heart love
💗 growing heart
💓 beating heart
💕 two hearts love
💞 revolving hearts
💘 heart with arrow
💝 heart with ribbon gift
❤️‍🔥 heart on fire passion
❤️‍🩹 mending heart
💔 broken heart sad
❣️ heart exclamation
💯 hundred points perfect 100 keep it
💢 anger symbol
💥 collision boom
💫 dizzy stars
💦 sweat droplets
💨 dashing away fast
🕳️ hole
💬 speech balloon comment
💭 thought balloon think
💤 zzz sleep`,
  'Nature': `
🐶 dog face puppy
🐱 cat face kitten
🐭 mouse face
🐹 hamster
🐰 rabbit face bunny
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger face
🦁 lion
🐮 cow face
🐷 pig face
🐸 frog
🐵 monkey face
🐔 chicken
🐧 penguin
🐦 bird
🦉 owl wise
🦄 unicorn magic
🐝 honeybee bee busy
🐛 bug caterpillar
🦋 butterfly
🐌 snail slow
🐢 turtle slow
🐍 snake
🐙 octopus
🦀 crab
🐳 spouting whale
🐬 dolphin
🦈 shark
🌵 cactus
🌲 evergreen tree
🌱 seedling grow start
🍀 four leaf clover luck
🍁 maple leaf autumn
🌸 cherry blossom spring flower
🌻 sunflower
🌹 rose flower
💐 bouquet flowers thanks
☀️ sun sunny
🌤️ sun behind small cloud
⛅ sun behind cloud
🌧️ cloud with rain
⛈️ cloud with lightning storm
❄️ snowflake cold winter
🌈 rainbow
⚡ high voltage lightning fast
🔥 fire lit hot great
💧 droplet water
🌊 water wave ocean
🌙 crescent moon night
⭐ star favorite
🌟 glowing star
✨ sparkles magic shiny new
☄️ comet
🌍 globe europe africa world earth
🌎 globe americas world earth
🌏 globe asia australia world earth`,
  'Food': `
🍎 red apple
🍊 tangerine orange
🍋 lemon sour
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🍒 cherries
🍑 peach
🥑 avocado
🌶️ hot pepper spicy
🌽 corn
🥕 carrot
🥐 croissant
🍞 bread
🧀 cheese
🍳 cooking egg
🥞 pancakes
🥓 bacon
🍔 hamburger burger
🍟 french fries
🍕 pizza
🌭 hot dog
🌮 taco
🌯 burrito
🍝 spaghetti pasta
🍜 steaming bowl ramen noodles
🍣 sushi
🍱 bento box
🍩 doughnut donut
🍪 cookie
🎂 birthday cake
🍰 shortcake cake
🧁 cupcake
🍫 chocolate bar
🍿 popcorn
🍦 soft ice cream
☕ hot beverage coffee tea
🍵 teacup
🧋 bubble tea
🍺 beer mug cheers
🍻 clinking beer mugs cheers
🥂 clinking glasses cheers toast celebrate
🍷 wine glass
🍸 cocktail glass
🍾 bottle with popping cork champagne celebrate`,
  'Activities': `
🎉 party popper celebrate congrats tada hooray
🎊 confetti ball celebrate
🎈 balloon party
🎁 wrapped gift present
🎀 ribbon
🏆 trophy win winner champion
🥇 first place medal gold winner
🥈 second place medal silver
🥉 third place medal bronze
🏅 sports medal
🎖️ military medal
⚽ soccer ball football
🏀 basketball
🏈 american football
⚾ baseball
🎾 tennis
🏐 volleyball
🎳 bowling
⛳ flag in hole golf
🎯 bullseye direct hit target on point
🎮 video game controller gaming
🕹️ joystick
🎲 game die dice chance
🧩 puzzle piece
♟️ chess pawn strategy
🎨 artist palette art design
🎬 clapper board film action
🎤 microphone sing
🎧 headphone music listen
🎵 musical note music
🎶 musical notes music
🎸 guitar rock
🎹 musical keyboard piano
🥁 drum drumroll
🎭 performing arts theater
🚀 rocket launch ship fast deploy
✈️ airplane travel flight
🚗 automobile car
🚲 bicycle bike
⛵ sailboat
🏖️ beach with umbrella vacation
🏔️ snow capped mountain
🏠 house home
🏢 office building work
🏗️ building construction wip
🗺️ world map
🧭 compass direction
⏰ alarm clock time wake
⏳ hourglass not done waiting
⌛ hourglass done time up
⏱️ stopwatch timer
📅 calendar date
📆 tear off calendar schedule`,
  'Objects': `
💡 light bulb idea
🔦 flashlight
🕯️ candle
📱 mobile phone
💻 laptop computer
🖥️ desktop computer
⌨️ keyboard typing
🖱️ computer mouse
💾 floppy disk save
📷 camera photo
🎥 movie camera video
📺 television tv
📻 radio
🔋 battery
🔌 electric plug
📡 satellite antenna
🔍 magnifying glass search look
🔎 magnifying glass right search
🔒 locked secure private
🔓 unlocked open
🔑 key password access
🔨 hammer build fix
🪛 screwdriver fix
🔧 wrench fix tool
⚙️ gear settings config
🧰 toolbox tools
🧪 test tube experiment test
🔬 microscope science research
🧬 dna science
💊 pill medicine
🩹 adhesive bandage fix patch
🧹 broom clean up sweep
🧽 sponge clean
🪣 bucket
🛒 shopping cart buy
💰 money bag
💵 dollar banknote money cash
💳 credit card payment
📈 chart increasing up growth trend
📉 chart decreasing down
📊 bar chart stats data
📋 clipboard list
📌 pushpin pin
📍 round pushpin location
📎 paperclip attach
✂️ scissors cut
📝 memo note write
✏️ pencil edit write
🖊️ pen
🖋️ fountain pen sign
📚 books read study docs
📖 open book read
📓 notebook
📒 ledger
📄 page facing up document
📁 file folder
📂 open file folder
🗂️ card index dividers organize
🗃️ card file box archive
🗑️ wastebasket trash delete
📦 package box ship delivery
📮 postbox mail
📬 open mailbox with raised flag mail
📧 e mail email
📣 megaphone announce
📢 loudspeaker announce
🔔 bell notification
🔕 bell with slash mute
🏷️ label tag
🔖 bookmark
⚖️ balance scale justice fair
🧲 magnet
🪄 magic wand
🔮 crystal ball predict future
🧿 nazar amulet
🎫 ticket
🚩 triangular flag red flag warning
🏁 chequered flag finish done race
🏳️ white flag surrender
🏴 black flag`,
  'Symbols': `
✅ check mark button done yes complete
☑️ check box with check done
✔️ check mark done
❌ cross mark no wrong cancel
❎ cross mark button
➕ plus add
➖ minus remove
❓ red question mark question explain what
❔ white question mark
❗ red exclamation mark important
❕ white exclamation mark
⚠️ warning caution careful
🚫 prohibited no forbidden
⛔ no entry stop
🛑 stop sign stop
🔴 red circle
🟠 orange circle
🟡 yellow circle
🟢 green circle go ok
🔵 blue circle
🟣 purple circle
⚫ black circle
⚪ white circle
🟥 red square
🟩 green square
🟦 blue square
🔺 red triangle pointed up
🔻 red triangle pointed down
♻️ recycling symbol reuse
✳️ eight spoked asterisk
❇️ sparkle
⭕ hollow red circle
🆗 ok button
🆕 new button new
🆒 cool button
🆙 up button
🆘 sos button help
🔝 top arrow
🔜 soon arrow
🔙 back arrow
🔄 counterclockwise arrows button refresh retry repeat
🔁 repeat button loop
🔀 shuffle tracks button
⬆️ up arrow
⬇️ down arrow
⬅️ left arrow
➡️ right arrow
↩️ right arrow curving left undo reply
↪️ left arrow curving right
⤴️ right arrow curving up
⏩ fast forward button
⏪ fast reverse button
⏸️ pause button pause
▶️ play button play
⏹️ stop button
⏺️ record button
🔇 muted speaker mute
🔊 speaker high volume loud
➰ curly loop
™️ trade mark
©️ copyright
®️ registered
💲 heavy dollar sign
♾️ infinity forever
🔢 input numbers
#️⃣ keycap number sign hash
*️⃣ keycap asterisk
0️⃣ keycap 0 zero
1️⃣ keycap 1 one
2️⃣ keycap 2 two
3️⃣ keycap 3 three
4️⃣ keycap 4 four
5️⃣ keycap 5 five
6️⃣ keycap 6 six
7️⃣ keycap 7 seven
8️⃣ keycap 8 eight
9️⃣ keycap 9 nine
🔟 keycap 10 ten`,
  'Flags': `
🏳️‍🌈 rainbow flag pride
🏴‍☠️ pirate flag
🇺🇳 flag united nations
🇪🇺 flag european union
🇺🇸 flag united states usa america
🇨🇦 flag canada
🇲🇽 flag mexico
🇧🇷 flag brazil
🇦🇷 flag argentina
🇬🇧 flag united kingdom uk britain
🇮🇪 flag ireland
🇫🇷 flag france
🇩🇪 flag germany
🇪🇸 flag spain
🇵🇹 flag portugal
🇮🇹 flag italy
🇳🇱 flag netherlands
🇸🇪 flag sweden
🇳🇴 flag norway
🇩🇰 flag denmark
🇫🇮 flag finland
🇵🇱 flag poland
🇺🇦 flag ukraine
🇨🇭 flag switzerland
🇬🇷 flag greece
🇹🇷 flag turkey
🇮🇱 flag israel
🇪🇬 flag egypt
🇳🇬 flag nigeria
🇰🇪 flag kenya
🇿🇦 flag south africa
🇮🇳 flag india
🇨🇳 flag china
🇯🇵 flag japan
🇰🇷 flag south korea
🇸🇬 flag singapore
🇮🇩 flag indonesia
🇵🇭 flag philippines
🇻🇳 flag vietnam
🇹🇭 flag thailand
🇦🇺 flag australia
🇳🇿 flag new zealand`,
};

export const CATEGORIES: EmojiCategory[] = Object.entries(SOURCE).map(([name, lines]) => ({
  name,
  emoji: lines
    .trim()
    .split('\n')
    .map((line) => {
      const at = line.indexOf(' ');
      return { emoji: line.slice(0, at), words: line.slice(at + 1) };
    }),
}));

/** The emoji whose words have every word of `query` at the start of one of theirs, in catalog order. */
export function searchEmoji(query: string): EmojiEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: EmojiEntry[] = [];
  for (const c of CATEGORIES) {
    for (const e of c.emoji) {
      const words = e.words.split(' ');
      if (terms.every((t) => words.some((w) => w.startsWith(t)) || e.emoji === t)) out.push(e);
    }
  }
  return out;
}
