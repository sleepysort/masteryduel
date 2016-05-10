# Mastery Duel #

   Play at **masteryduel.com**

Mastery Duel is an entry for the Riot Games API Challenge 2016 made by SleepyBox and Bouhm. It is a multiplayer web game in which two players face-off with their decks of choice, representing the Champion masteries of the respective Summoners, in a turn-based strategy card game.

## Game Design ##

We decided to make a card game because it could utilize the large and diverse pool of champions in League of Legends well. Champion Masteries are something Summoners would be proud of and would want to show off, so we thought high level mastery cards could be like status symbols of decks similar to rare edition, shiny, or foil trading cards. With a multiplayer 1 on 1 experience, players can also directly test the power of their mastered champion pools against those of other players, along with the freedom to play with other players' champion masteries.

We mixed the general card game design of a turn-based battle between the players' cards and the opponents' cards, with a League of Legends flair. Incorporating the lanes to added a sense of familiarity to the game for League of Legends players and also opened up interesting strategic avenues.

With the focus on Champion Masteries, we wanted to give the players satisfaction when they drew a high mastery level champion from the deck and play it. With three lanes instead of one battlefield, individual champions could be more effective. High mastery champions would feel overwhelming. Balance is nice, but so is dominance.


### Champion Design ###

We wanted each champion to feel unique, but within reasonable bounds. 130 champions was a lot to work with within the time constraints from a late start. We tried to incorporate as much of the champion data from the API as possible in coming up with the stats for each champion so that with any new changes or new champions, the changes would be reflected automatically. Each of the champion's stats, the base health, damage, and respective scalings, are calculated based on the champion's tags and mastery levels. The basic motivation for balancing health and damage would follow the strengths and weaknesses of each tag (Assassin, Tank, Marksman, etc) in League of Legends. To add some more diversity, each of the champions have certain values further tweaked in a way we felt was closer to the champion in League of Legends. We took more liberties in scaling based on mastery levels; since players worked hard to earn their mastery points on their champions, they should feel satisfaction when high mastery champion obliterates its lower mastery level enemies.

Implementing each of the champion's abilities was the main way of individualizing each champion. We tried to implement abilities that best reflected the identity of the champion. This had to be within the workable framework that we build from the ground up for the game. There are many different iterations of abilities that we could implement, with enough similarity to help with game balance and enough diversity to expand strategic plays. We tried to implement champion abilities from the game that would work and be interesting in a turn-based game. Otherwise, we took creative liberties to represent the champions in a way that still captured the champion. Several examples of this include reset mechanics that allow the champion to take another action upon getting a kill, a system of status effects that operate on turns, and abilities that interact directly with allies or enemies like Blitzcrank's Rocket Grab or Thresh's Dark Passage.