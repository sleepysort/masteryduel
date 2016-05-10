# Mastery Duel #

   Play at **masteryduel.com**

Mastery Duel is an entry for the Riot Games API Challenge 2016 made by SleepyBox and Bouhm. It is a multiplayer web game in which two players face-off with their decks of choice, representing the Champion masteries of the respective Summoners, in a turn-based strategy card game. 

Currently only supports NA summoners, and is really only playable at a resolution above 1366x768.

## Game Design ##

We decided to make a card game because it could utilize the large and diverse pool of champions in League of Legends well. Champion Masteries are something Summoners would be proud of and would want to show off, so we thought high level mastery cards could be like status symbols of decks similar to rare edition, shiny, or foil trading cards. With a multiplayer 1 on 1 experience, players can also directly test the power of their mastered champion pools against those of other players, along with the freedom to play with other players' champion masteries.

We mixed the general card game design of a turn-based battle between the players' cards and the opponents' cards, with a League of Legends flair. Incorporating the lanes to added a sense of familiarity to the game for League of Legends players and also opened up interesting strategic avenues.

With the focus on Champion Masteries, we wanted to give the players satisfaction when they drew a high mastery level champion from the deck and play it. With three lanes instead of one battlefield, individual champions could be more effective. High mastery champions would feel overwhelming. Balance is nice, but so is dominance.


### Champion Design ###

We wanted each champion to feel unique, but within reasonable bounds. 130 champions was a lot to work with within the time constraints from a late start. We tried to incorporate as much of the champion data from the API as possible in coming up with the stats for each champion so that with any new changes or new champions, the changes would be reflected automatically. Each of the champion's stats, the base health, damage, and respective scalings, are calculated based on the champion's tags and mastery levels. The basic motivation for balancing health and damage would follow the strengths and weaknesses of each tag (Assassin, Tank, Marksman, etc) in League of Legends. To add some more diversity, each of the champions have certain values further tweaked in a way we felt was closer to the champion in League of Legends. We took more liberties in scaling based on mastery levels; since players worked hard to earn their mastery points on their champions, they should feel satisfaction when high mastery champion obliterates its lower mastery level enemies.

Implementing each of the champion's abilities was the main way of individualizing each champion. We tried to implement abilities that best reflected the identity of the champion. This had to be within the workable framework that we build from the ground up for the game. There are many different iterations of abilities that we could implement, with enough similarity to help with game balance and enough diversity to expand strategic plays. We tried to implement champion abilities from the game that would work and be interesting in a turn-based game. Otherwise, we took creative liberties to represent the champions in a way that still captured the champion. Several examples of this include reset mechanics that allow the champion to take another action upon getting a kill, a system of status effects that operate on turns, and abilities that interact directly with allies or enemies like Blitzcrank's Rocket Grab or Thresh's Dark Passage.

## Game Development ##

There were a number of engineering considerations while developing this game. Both of us had developed small hobby games in the past, but this was one of the more ambitious projects we chose to work on. Furthermore, unlike previous games we've made before, we decided to forgo using an existing game engine, since a turn based card game could leverage the capabilities of HTML5 and CSS3 for the rendering. 

### Technology ###

Mastery duel was built on Angular 2 for the client, and Node/Express for the server, using Socket.IO for communication. All of our code was written in Typescript because (a) less mental context switching when going from working on the frontend to the backend, and (b) compile time errors are far less painful than ugly bugs that stay hidden until 11:00pm of the due date. All in all, we were fairly happy with our technology stack, and since we were by no means experts when we started, we learned quite a bit as well.

### Designing the Protocol ###

There are 4 states of the game: the waiting stage, the selection stage, the in-game stage, and the over stage. To move from stage to stage, we designed a communication protocol between the client and the server. There is first an initial handshake to get the players through the waiting and selection stage. Once at the in-game stage, the current turn's player sends up the move that they made. The server processes and broadcasts an update to both players. The majority of the game is made up of these game moves and game updates.

### Building the Game Server and Web Client ###

The state of every game was to be managed by the server. We chose to do it this way to prevent people from potentially exploiting the game. The clients were only permitted to tell the server what their move was (i.e. champion x attacks champion y), then the server would determine whether that move was legal, and what the effects of that move were.

This was our first time using Angular 2, and we were pretty impressed with the out of the box capabilities of the framework. Unfortunately, due to our limited experience and Angular 2 still being in beta, we ended up abusing the framework and used some pretty horrible anti-patterns (please don't judge us).

### Performance ###

Due to time constraints, we were not able to meet the performance expectations that we had for Mastery Duel. Since all of the computations were done on the server, there was a pretty substantial risk that the server would not be able to handle many games at a time, since Node is naturally single threaded. Furthermore, there were some memory leaks that we were still unable to track down. As we continue to work on this, we hope to rearchitect our application to be more performant.

## Things we didn't get to do ##

We barely had any time to play this game ourselves! As a result, we didn't get to look at the balance of each champion relative to each other. The UI is not as polished as we would have hoped, and we didn't get to implement our ideas for animating the champions' moves. Other things like DoTs, helpers and traps, supporting all regions, being playable on all devices, and general bug bashing were also high on our list. Hopefully we will be able to revisit and see those to completion.

## Afterthoughts ##

We thoroughly believe that with the time constraints of the competition, Angular 2 and Node/Express were great choices. We managed to get an MVP of our game completely from scratch out in a matter of days. That being said, we definitely had some performance limitations that we were not able to address. As we continue to work on this in the future, we would probably want to step back and reassess the architecture of our system, and perhaps migrate to a different technology stack.
