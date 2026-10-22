// Friendly, safe word lists for openboard link tokens. Hand-written; no names,
// no slurs, nothing violent. All lowercase a-z (SCENES are hyphenated phrases).

const words = (s: string): readonly string[] => s.trim().split(/\s+/);

export const ADJECTIVES: readonly string[] = words(`
able active adorable agile airy alert amber amused ancient angelic apricot arctic artful
astral atomic azure bashful beaming bendy bold bouncy brave breezy bright brisk bubbly
buoyant busy calm candid careful cheeky cheerful chilly chipper chirpy classy clever cosmic
cosy crafty creamy crisp crispy cuddly curious curly dainty dandy dapper dashing dazzling
dear deft delicate dewy dizzy dreamy dusty eager earnest easy elegant epic ethereal even
exotic fabled fair fancy fearless feathery fiery fine fizzy flaxen fleecy fluffy fluent
flowery fond frank fresh friendly frosty frugal fuzzy gallant gentle giddy gifted gleaming
glad glassy gleeful glimmering glossy glowing golden graceful grand grateful groovy hardy
harmonious hazy healthy hearty helpful heroic honest hopeful humble husky icy idle ideal
immense indigo inky intrepid jade jaunty jazzy jolly jovial joyful jubilant juicy keen
kind kindly knowing lacy lavish lazy leafy legendary lemony lilac limber lively lofty
lovely loyal lucky lunar lush lustrous magic magical majestic mellow merry mighty mild
minty mirthful misty modest mossy mystic nifty nimble noble nocturnal normal nutty oaken
oceanic odd olive open optimistic orange orderly outgoing painted patient peaceful peachy
pearly peppy perky petite pink placid plucky plump polite polished posh precious pretty
prime proud puffy pure purring quaint quick quiet quirky radiant rapid rare ready regal
relaxed resolute rich roomy rosy round royal rustic sage salty sandy sassy satin scarlet
scenic serene shady sharp shimmering shiny shy silent silken silky silver simple sincere
sleek sleepy slender smart smiling smooth snappy snazzy snowy snug soft solar sparkling
speedy spicy spirited splendid spotted spry spunky squeaky stable stellar sturdy stylish
sublime sugary sunlit sunny super supple sweet swift tame tangy tawny teal tender thankful
thoughtful thrifty tidy tiny toasty topaz tranquil trusty twinkling umber unique upbeat
valiant velvet vibrant vivid wandering warm wavy weightless whimsical wild willing windy
winged wise wistful witty wonderful woolly woven yellow young youthful zany zealous zesty
zippy
`);

export const ANIMALS: readonly string[] = words(`
albatross alpaca anchovy angelfish ant anteater antelope armadillo axolotl baboon badger
barnacle barracuda bat bear beaver bee beetle bison blackbird bluebird bobcat bonobo
budgie bumblebee bunny butterfly buzzard camel canary capybara cardinal caribou cat
caterpillar catfish chameleon cheetah chickadee chicken chinchilla chipmunk clam cobra
cockatoo condor coral cormorant cougar cow coyote crab crane cricket crocodile crow cuckoo
curlew deer dingo dolphin donkey dove dragonfly duck dugong eagle eel egret elephant elk
emu falcon ferret finch firefly flamingo flounder fly fox frog gazelle gecko gerbil gibbon
giraffe goat goldfinch goldfish goose gopher gorilla grasshopper grouse guppy gull haddock
hamster hare hawk hedgehog heron herring hippo hornet horse hummingbird hyena ibex ibis
iguana impala jackal jaguar jay jellyfish kangaroo kingfisher kiwi koala koi krill ladybug
lamb lark lemming lemur leopard lion lizard llama lobster loon lynx macaw magpie mallard
manatee mandrill mantis marmot marten meerkat mink minnow mockingbird mole mongoose monkey
moose moth mouse mule narwhal newt nightingale numbat ocelot octopus okapi opossum orca
oriole oryx osprey ostrich otter owl ox oyster panda panther parakeet parrot partridge
peacock pelican penguin perch pheasant pigeon pika piranha platypus plover pony poodle
porcupine porpoise possum prawn puffin puma quail quokka rabbit raccoon ram raven reindeer
rhino roadrunner robin rooster salamander salmon sandpiper sardine scallop seagull seahorse
seal shark sheep shrew shrimp skink skunk sloth snail snipe sparrow spider squid squirrel
starfish starling stingray stoat stork sturgeon swallow swan swift tapir tarsier termite
tern thrush tiger toad tortoise toucan trout tuna turkey turtle viper vole wallaby walrus
warbler wasp weasel whale whippet wildcat wolf wombat woodpecker wren yak zebra
`);

export const SCENES: readonly string[] = words(`
in-the-sun in-the-rain in-the-snow in-the-fog in-the-mist in-the-breeze in-the-garden
in-the-meadow in-the-forest in-the-woods in-the-valley in-the-clouds in-the-moonlight
in-the-starlight in-the-dawn in-the-dusk in-the-twilight in-the-spring in-the-summer
in-the-autumn in-the-winter in-the-shade in-the-orchard in-the-grass in-the-reeds
in-the-lagoon in-the-harbor in-the-canyon in-the-cove in-the-glade in-the-grove
in-the-hills in-the-sky on-the-hill on-the-ridge on-the-shore on-the-beach on-the-dune
on-the-river on-the-lake on-the-pond on-the-porch on-the-roof on-the-trail on-the-path
on-the-meadow on-the-prairie on-the-cliff on-the-island on-the-moor on-the-farm
on-the-wave on-the-breeze on-the-branch on-the-boat by-the-sea by-the-lake by-the-river
by-the-brook by-the-creek by-the-pond by-the-fire by-the-window by-the-lantern
by-the-barn by-the-bridge by-the-oak by-the-pine by-the-waterfall by-the-lighthouse
by-the-campfire under-the-moon under-the-stars under-the-sun under-the-tree
under-the-bridge under-the-rainbow under-the-umbrella under-the-willow above-the-clouds
beyond-the-hills beside-the-stream near-the-meadow
`);
