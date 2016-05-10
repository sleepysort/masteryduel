import fetcher = require('../util/fetcher');
import generator = require('../util/generator');
import gm = require('./gamesmanager');
import constants = require('../constants');
import I = require('./interfaces');
import Logger = require('../util/logger');
import CT = require('./championtags');
import SC = require('./statcomputer');
import sanitizer = require('sanitizer');

/**************************************************************************************************
* DO NOT DEPLOY WITH DEBUG ENABLED
**************************************************************************************************/
const DEBUG_ENABLED = true;
/**************************************************************************************************
* DO NOT DEPLOY WITH DEBUG ENABLED
**************************************************************************************************/

/**
* Represents the various stages of the game
*/
export enum GameState {
	/** DO NOT USE */
	None,
	/** Not enough players to begin */
	Waiting,
	/** Players are picking their decks */
	NotStarted,
	/** Game is in progress */
	Started,
	/** Game is over */
	Over
}

/**
* Representation of the game and the state of the game
*/
export class Game {
	/** The unique id for this game */
	private gameId: string;

	/** Enum representing the current stage of the game */
	private gameState: GameState;

	/** The turn number of the game. 0 is before the game starts. Nexus is invulnerable until turn 4. */
	private turnNum: number;

	/** The number of moves left in this turn */
	private movesCount: number;

	/** Dictionary of active champions in the game (active meaning in hand or on the rift) */
	private activeChamps: {[uid: string]: Champion};

	/** The players in this game */
	private players: Player[];

	/** Turn timer */
	private turnTimer: NodeJS.Timer;

	/**
	* @param the game id for this game
	*/
	constructor(gameId: string) {
		this.gameId = gameId;
		this.gameState = GameState.Waiting;
		this.turnNum = 0;
		this.movesCount = 0;
		this.activeChamps = {};
		this.players = [];
	}

	//////////////////////////////////////////////////////////////////////////////////////////////////
	// Player management methods
	//////////////////////////////////////////////////////////////////////////////////////////////////

	/**
	* Adds a player to the game
	* @throws Error if the game is full
	* @param sock	socket that is connected to the player
	* @return the generated playerId for this player
	*/
	public addPlayer(sock: SocketIO.Socket): string {
		if (this.players.length === constants.MAX_PLAYERS) {
			Logger.log(Logger.Tag.Network, 'Attempt to join game ' + this.gameId + ' rejected. Game is full.');
			throw new Error('The game is full.');
		}

		let newPlayerId = generator.generateId(6);
		let newPlayer = new Player(newPlayerId, sock);
		this.players.push(newPlayer);

		Logger.log(Logger.Tag.Game, 'Player ' + newPlayerId + ' successfully joined game.', this.gameId);

		sock.on('disconnect', () => {
			Logger.log(Logger.Tag.Network, 'Player ' + newPlayerId + ' disconnected from game ' + this.gameId + '.');

			if (this.gameState === GameState.Over) {
				console.log('wah');
				return;
			}

			// Game was never started
			let winner;
			if (this.gameState === GameState.Started) {
				winner = this.getOpponent(newPlayer.getId());
			}
			this.onGameOver(winner);

			return;
		});

		let ackMsg: I.DataGameJoinAck = {
            success: true,
            playerId: newPlayerId
        };

        sock.emit('gamejoin-ack', ackMsg);

		sock.on('gamechat', (msg) => {
			msg.text = sanitizer.escape(sanitizer.sanitize(msg.text));
			this.emitAll('gamechat', msg);
		});

		if (this.players.length === constants.MAX_PLAYERS) {
			this.gameState = GameState.NotStarted;

			Logger.log(Logger.Tag.Game, 'Waiting for players to get ready.', this.gameId);

			// TODO: Right now, we are relying on the correctness of the client's message for the player id, when we should really just be using it for validation
			this.onAll('gameselect', (msg: I.DataGameSelect) => {
				let player = this.getPlayer(msg.playerId);

				// Get the summoner id from name, then load mastery data, then load the deck.
				// If all players are loaded, initialize the game.
				fetcher.getSummonerId(msg.summonerName)
						.then(fetcher.getSummonerDeck)
						.then((value: {icon: number, name: string, body: I.ChampionMinData[]}) => {
							if (value.body.length < 15) {
								throw 'This summoner does not have the minimum number of mastered champions to play (15).';
							}
							player.setDeck(Deck.createDeck(value.name, value.body));

							Logger.log(Logger.Tag.Game, 'Successfully loaded deck \'' + msg.summonerName + '\' for player ' + player.getId(), this.gameId);

							player.iconNumber = value.icon;

							let selAck: I.DataGameSelectAck = { success: true };
							player.getSocket().emit('gameselect-ack', selAck);

							return this.isGameReady();
						}).then((value: boolean) => {
							// Both players have loaded their decks
							if (value) {
								Logger.log(Logger.Tag.Game, 'All players loaded. Initializing game.', this.gameId);

								this.onGameStarted();
								this.offAll('gameselect');

								this.onAll('gamemove', (move: I.DataGameMove) => {
									this.applyMove(move);
								});

								this.onAll('gamepass', (pass: I.DataGamePass) => {
									clearInterval(this.turnTimer);
									this.intervalHandler();
									this.turnTimer = setInterval(this.intervalHandler, constants.TURN_TIMER * 1000);
								});
							}
						}).catch((err) => {
							player.getSocket().emit('gameerror', {reason: err});
						});
			});

			let prepMsg: I.DataGamePrep = { message: "Select a summoner deck." };
			this.emitAll('gameprep', prepMsg);

			// If debugging is enabled, listen for debug events
			if (DEBUG_ENABLED) {
				this.onAll('gamedebug', (msg) => {
					let player = this.getPlayer(msg.playerId);
					let hand = this.getHand(player.getId());

					let update: I.DataGameUpdate = {
						sourceUid: null,
						killed: [],
						hand: [],
						turnNum: this.turnNum,
						turnPlayer: this.getCurrentTurnPlayerId(),
						moveCount: this.movesCount
					};

					for (let i = 0; i < Math.min(5, msg.spawn.length); i++) {
						update.killed.push({
							uid: hand[i].getUid(),
							killer: hand[i].getUid(),
						});
						delete this.activeChamps[hand[i].getUid()];
						let champ = createChampionById(player.getId(), msg.spawn[i], 5);
						this.activeChamps[champ.getUid()] = champ;
						update.hand.push(champ);
					}

					player.getSocket().emit('gameupdate', update);
				});
			}
		}

		return newPlayerId;
	}

	public intervalHandler = () => {
		this.turnNum++;
		this.movesCount = 3;

		let update: I.DataGameUpdate = {
			sourceUid: null,
			moveCount: this.movesCount,
			turnNum: this.turnNum,
			turnPlayer: this.players.length === 2 ? this.getCurrentTurnPlayerId() : null
		};

		this.emitAll('gameupdate', update);
	}

	/**
	* @param the player id
	* @return the Player object with the given id; null if it doesn't exist
	*/
	public getPlayer(playerId: string): Player {
		for (let i = 0; i < this.players.length; i++) {
			if (this.players[i].getId() === playerId) return this.players[i];
		}
		return null;
	}

	/**
	* @param the player id
	* @return the Player object of the opponent (i.e. not the one with the given id); null if it doesn't exist
	*/
	public getOpponent(playerId: string): Player {
		for (let i = 0; i < this.players.length; i++) {
			if (this.players[i].getId() !== playerId) return this.players[i];
		}
		return null;
	}

	/**
	* @return the number of players in the game
	*/
	public getPlayerCount(): number {
		return this.players.length;
	}

	/**
	* @throws Error if the player doesn't have 5 cards
	* @return the hand of the given player
	*/
	public getHand(playerId: string): Champion[] {
		let player = this.getPlayer(playerId);
		let result = [];
		for (let uid in this.activeChamps) {
			if (this.activeChamps[uid].getOwner() === player.getId()
					&& this.activeChamps[uid].getLocation() === Location.Hand) {
				result.push(this.activeChamps[uid]);
			}
		}

		if (result.length !== 5) {
			throw new Error(playerId + 'does not have 5 cards in hand');
		}

		return result;
	}

	/**
	* @return the player id of the player whose current turn it is
	*/
	public getCurrentTurnPlayerId(): string {
		return this.players[this.turnNum % this.players.length].getId();
	}

	/**
	* @return the current turn number
	*/
	public getTurnNum(): number {
		return this.turnNum;
	}

	/**
	* @return the champion with the given uid; null if not found
	*/
	public getChamp(uid: string) {
		return this.activeChamps[uid];
	}

	/**
	* @return all enemy champions in the same lane as the given champion; empty array if none
	*/
	public getSameLaneEnemyChamps(uid: string): Champion[] {
		let champ = this.activeChamps[uid];
		let result: Champion[] = [];
		for (let key in this.activeChamps) {
			let curr = this.activeChamps[key];
			if (curr.getOwner() !== champ.getOwner()
					&& curr.getLocation() === champ.getLocation()) {
				result.push(curr);
			}
		}
		return result;
	}

	/**
	* @return all allied champions in the same lane as the given champion; empty array if none
	*/
	public getSameLaneAllyChamps(uid: string): Champion[] {
		let champ = this.activeChamps[uid];
		let result: Champion[] = [];
		for (let key in this.activeChamps) {
			let curr = this.activeChamps[key];
			if (curr.getOwner() === champ.getOwner()
					&& curr.getLocation() === champ.getLocation()) {
				result.push(curr);
			}
		}
		return result;
	}

	/**
	* @return all enemy champions of the given champion; empty array if none
	*/
	public getAllEnemyChamps(uid: string): Champion[] {
		let champ = this.activeChamps[uid];
		let result: Champion[] = [];
		for (let key in this.activeChamps) {
			let curr = this.activeChamps[key];
			if (curr.getOwner() !== champ.getOwner()) {
				result.push(curr);
			}
		}
		return result;
	}

	/**
	* @return all allied champions of the given champion; empty array if none
	*/
	public getAllAlliedChamps(uid: string): Champion[] {
		let champ = this.activeChamps[uid];
		let result: Champion[] = [];
		for (let key in this.activeChamps) {
			let curr = this.activeChamps[key];
			if (curr.getOwner() === champ.getOwner()) {
				result.push(curr);
			}
		}
		return result;
	}

	//////////////////////////////////////////////////////////////////////////////////////////////////
	// Socket event listener helper methods
	//////////////////////////////////////////////////////////////////////////////////////////////////

	/**
	* Transmits the given data to all player sockets
	* @param event	the event type to emit
	* @param data	the data to transmit
	*/
	public emitAll(event: string, data?: any): void {
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].getSocket().emit(event, data);
		}
	}

	/**
	* Attaches a given handler to all player sockets
	* @param event		the event type to listen for
	* @param handler	the handler to attach
	*/
	public onAll(event: string, handler: any): void {
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].getSocket().on(event, handler);
		}
	}

	/**
	* Removes all handlers of a given event type for all player sockets
	* @param event	the event type to detach from
	*/
	public offAll(event: string): void {
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].getSocket().removeAllListeners(event);
		}
	}


	//////////////////////////////////////////////////////////////////////////////////////////////////
	// Game state and lifecycle methods
	//////////////////////////////////////////////////////////////////////////////////////////////////

	/**
	* @return whether all players are ready (i.e. have selected summoner decks)
	*/
	public isGameReady(): boolean {
		let ready = this.players.length === 2;
		for (let i = 0; i < this.players.length; i++) {
			ready = ready && this.players[i].isReady();
		}
		return ready;
	}

	/**
	* @return the turn number of the game
	*/
	public getGameTurnNum(): number {
		return this.turnNum;
	}

	/**
	* @return whether there are 0 players in the game
	*/
	public isGameEmpty(): boolean {
		return this.players.length === 0;
	}

	/**
	* Handles the transition from the NotStarted stage to the Started stage
	*/
	private onGameStarted(): void {
		this.gameState = GameState.Started;
		this.turnNum = 1;
		this.movesCount = 2;

		let icons = {};
		let summoners = {};

		for (let i = 0; i < this.players.length; i++) {
			this.players[i].initializeHand(5, this.activeChamps);

			this.players[i].getSocket().emit('gameinit', {
				hand: this.getHand(this.players[i].getId()),
				starter: this.getCurrentTurnPlayerId(),
				playerIcon: this.players[i].iconNumber,
				enemyIcon: this.getOpponent(this.players[i].getId()).iconNumber,
				playerSummonerName: this.players[i].getDeck().getSummonerName(),
				enemySummonerName: this.getOpponent(this.players[i].getId()).getDeck().getSummonerName(),
				nexusHealth: constants.NEXUS_STARTING_HEALTH
			});
		}

		this.turnTimer = setInterval(this.intervalHandler, constants.TURN_TIMER * 1000);  // 1 second additional buffer
	}

	/**
	* Handles the transition from the Started stage to the Over stage
	*/
	private onGameOver(player: Player): void {
		clearInterval(this.turnTimer);
		if (player) {
			this.emitAll('gameover', {victor: player.getId()});
			this.gameState = GameState.Over;
			Logger.log(Logger.Tag.Game, 'Game ended with ' + player.getId() + ' as the victor.', this.gameId);
		} else {
			this.emitAll('gameover', {victor: null});
		}
		this.offAll('gamechat');
		this.offAll('gameselect');
		this.offAll('gamepass');
		gm.GamesManager.getInstance().removeGame(this.gameId);
	}

	//////////////////////////////////////////////////////////////////////////////////////////////////
	// Game update methods
	//////////////////////////////////////////////////////////////////////////////////////////////////

	/**
	* Attempts to apply a given move and sends out the updates to the players. If the move
	* is invalid or illegal, a 'gameerror' event will be emitted to the violating player.
	*/
	private applyMove(move: I.DataGameMove) {
		let player = this.getPlayer(move.playerId);

		// TODO: fix this. It's a big problem; silent failure.
		if (player === null) return;
		let opponent = this.getOpponent(move.playerId);

		if (player.getId() !== this.getCurrentTurnPlayerId()) {
			player.getSocket().emit('gameerror', {
				reason: 'It is not your turn to make a move.',
			});
			return;
		}

		let update: I.DataGameUpdate = {
			sourceUid: null,
			moveCount: -1,
			turnNum: -1,
			turnPlayer: null,
			nexus: {},
			killed: [],
			damaged: [],
			hand: [],
			enemySpawn: [],
			moved: [],
			affected: [],
			cooldown: [],
			damageChange: []
		};

		let wasFromHand = false;

		try {
			if (move.attackNexus) {
				// True if the attacked player was defeated
				if (this.tryAttackNexus(player, move.attackNexus, update)) {
					this.onGameOver(player);
					return;
				}
			} else if (move.attackChamp) {
				this.tryAttackChamp(player, move.attackChamp, update);
			} else if (move.ability) {
				this.tryAbility(player, move.ability, update);
			} else if (move.moveChamp) {
				wasFromHand = this.tryMoveChamp(player, move.moveChamp, update);
			} else {  // Invalid move
				Logger.log(Logger.Tag.Game, 'Invalid move was made.', this.gameId);
				player.getSocket().emit('gameerror', {
					reason: 'Invalid move',
				});
				return;
			}
		} catch (err) {
			Logger.log(Logger.Tag.Game, err.message, this.gameId);
			player.getSocket().emit('gameerror', {
				reason: err.message
			});
			return;
		}

		// Was a valid move, unset the timer
		clearInterval(this.turnTimer);

		// Lol. If you look at this and not laugh, something is wrong with you.
		let opUpdate = JSON.parse(JSON.stringify(update));
		if (wasFromHand) {
			this.tryHandAndSpawn(player, move.moveChamp, update, opUpdate);
		}

		this.movesCount--;

		// Next player's turn
		if (this.movesCount === 0) {
			this.movesCount = 3;
			this.turnNum++;
		}

		this.tickFountains();

		update.turnNum = this.turnNum;
		update.turnPlayer = this.getCurrentTurnPlayerId();
		update.moveCount = this.movesCount;
		opUpdate.turnNum = this.turnNum;
		opUpdate.turnPlayer = this.getCurrentTurnPlayerId();
		opUpdate.moveCount = this.movesCount;

		player.getSocket().emit('gameupdate', update);
		opponent.getSocket().emit('gameupdate', opUpdate);

		// Reset the timer
		this.turnTimer = setInterval(this.intervalHandler, constants.TURN_TIMER * 1000);
	}

	/**
	* Ticks each player's fountain to decrement death timers and move champions from fountain to
	* deck.
	*/
	private tickFountains(): void {
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].tickFountain();
		}
	}

	private tryAttackNexus(player: Player, data: any, update: I.DataGameUpdate): boolean {
		let source = this.activeChamps[data.uid];
		update.sourceUid = source.getUid();

		if (source.getLocation() === Location.Hand) {
			throw new Error('Cannot attack from hand');
		}

		if (source.getStunnedTurn() >= this.turnNum) {
			throw new Error('This champion is stunned.');
		}

		if (source.getStasisTurn() >= this.turnNum) {
			throw new Error('This champion is in stasis.');
		}

		let opp = this.getOpponent(player.getId());

		// Check to see if there are enemies in the lane
		for (let uid in this.activeChamps) {
			let curr = this.activeChamps[uid];
			if (uid !== data.source && curr.getOwner() === opp.getId() && curr.getLocation() === source.getLocation()) {
				throw new Error('Enemy champion in the lane');
			}
		}

		if (opp.getInvulnTurn() >= this.turnNum) {
			throw new Error('Opponent nexus is invulnerable');
		}

		opp.applyDamage(source.getDamage());

		source.movedNum = this.turnNum;
		update.movedNum = source.movedNum;

		// Add data to update object
		update.nexus[opp.getId()] = opp.getHealth();

		return opp.getHealth() === 0;
	}

	private tryAttackChamp(player: Player, data: any, update: I.DataGameUpdate): void {
		let source = this.activeChamps[data.sourceUid];
		let target = this.activeChamps[data.targetUid];
		update.sourceUid = source.getUid();

		if (!source || !target) {
			throw new Error('Invalid source or target');
		}

		if (source.getOwner() !== player.getId()) {
			throw new Error('Attacking champion is not owned by player');
		}

		if (target.getOwner() === player.getId()) {
			throw new Error('Cannot attack your own champion');
		}

		if (source.getLocation() === Location.Hand) {
			throw new Error('Cannot attack from hand')
		}

		if (source.getLocation() !== target.getLocation()) {
			throw new Error('Cannot attack a champion in a different lane')
		}

		if (target.getInvulnTurn() >= this.turnNum || target.getStasisTurn() >= this.turnNum) {
			throw new Error('Target is invulnerable');
		}

		if (source.getStunnedTurn() >= this.turnNum) {
			throw new Error('Cannot attack while stunned');
		}

		if (source.getStasisTurn() >= this.turnNum) {
			throw new Error('Cannot attack while in stasis');
		}

		update.killed = [];
		update.damaged = [];

		// Keep track of original stats in case of update
		let originalHealth = source.getHealth();
		let originalDamage = source.getDamage();

		// If enemy is killed, send to fountain
		if (source.attackEnemy(this, target, this.getTurnNum(), update)) {
			this.getPlayer(target.getOwner()).sendToFountain(target);
			update.killed.push({uid: target.getUid(), killer: source.getUid()});
			delete this.activeChamps[target.getUid()];
		} else {
			update.damaged.push({
				uid: target.getUid(),
				health: target.getHealth(),
				attacker: source.getUid()
			});
		}

		if (originalHealth !== source.getHealth()) {
			update.damaged.push({
				uid: source.getUid(),
				health: source.getHealth(),
				attacker: source.getUid()
			});
		}

		if (originalDamage !== source.getDamage()) {
			update.damageChange.push({
				uid: source.getUid(),
				dmg: source.getDamage()
			});
		}

		update.movedNum = source.movedNum;
	}

	private tryAbility(player: Player, data: any, update: I.DataGameUpdate): void {
		let champ = this.activeChamps[data.sourceUid];
		update.sourceUid = champ.getUid();

		if (!champ) {
			throw new Error('Invalid champion');
		}

		if (champ.getOwner() !== player.getId()) {
			throw new Error('Cannot move opponent champion');
		}

		if (champ.getStunnedTurn() >= this.turnNum) {
			throw new Error('This champion is stunned.');
		}

		if (champ.getStasisTurn() >= this.turnNum) {
			throw new Error('This champion is in stasis.');
		}

		if (champ.getAbility().readyTurn >= this.turnNum) {
			throw new Error('Ability is on cooldown.');
		}

		if (champ.getLocation() === Location.Hand) {
			throw new Error('Cannot cast an ability from the hand.');
		}

		if (champ.movedNum >= this.turnNum) {
			throw new Error('Champion has already made a move this turn.');
		}

		champ.getAbility().readyTurn = champ.getAbility().effect(this, data, update) + this.turnNum;
		update.cooldown.push({ uid: champ.getUid() , readyTurn: champ.getAbility().readyTurn });
		update.movedNum = champ.movedNum;
	}

	private tryMoveChamp(player: Player, data: any, update: I.DataGameUpdate): boolean {
		let champ = this.activeChamps[data.uid];
		update.sourceUid = champ.getUid();

		if (!champ) {
			throw new Error('Invalid champion');
		}

		if (champ.getOwner() !== player.getId()) {
			throw new Error('Cannot move opponent champion');
		}

		if (data.targetLocation === champ.getLocation()) {
			throw new Error('Champion is already at this location');
		}

		if (data.targetLocation === Location.Hand) {
			throw new Error('Cannot move champion to hand');
		}

		if (champ.movedNum >= this.turnNum) {
			throw new Error('Champion has already move this turn');
		}

		if (champ.getLocation() === Location.Hand) {
			let count = 0;
			for (let key in this.activeChamps) {
				if (this.activeChamps[key].getLocation() !== Location.Hand
						&& this.activeChamps[key].getOwner() === player.getId()) {
					count++;
				}
			}
			if (count == 5) {
				throw new Error('Cannot have more than 5 champions out at a time.');
			}
		}

		if (data.targetLocation === Location.JungleTop || data.targetLocation === Location.JungleBot) {
			throw new Error('Jungles not yet implemented')
		}

		if (champ.getLocation() !== Location.Hand && champ.getLocation() !== Location.LaneMid && data.targetLocation !== Location.LaneMid) {
			throw new Error('Cannot move more than one lane over');
		}

		if (champ.getStunnedTurn() >= this.turnNum) {
			throw new Error('This champion is stunned.');
		}

		if (champ.getStasisTurn() >= this.turnNum) {
			throw new Error('This champion is in stasis');
		}

		let wasFromHand: boolean = champ.getLocation() === Location.Hand;

		// Keep track of original stats in case of update
		let originalHealth = champ.getHealth();
		let originalDamage = champ.getDamage();

		champ.setLocation(data.targetLocation, this.turnNum);

		if (originalHealth !== champ.getHealth()) {
			update.damaged.push({
				uid: champ.getUid(),
				health: champ.getHealth(),
				attacker: champ.getUid()
			});
		}

		if (originalDamage !== champ.getDamage()) {
			update.damageChange.push({
				uid: champ.getUid(),
				dmg: champ.getDamage()
			});
		}

		update.movedNum = champ.movedNum;

		update.moved.push({
			uid: champ.getUid(),
			location: champ.getLocation()
		});

		return wasFromHand;
	}

	public tryHandAndSpawn(player: Player, data: any, update: I.DataGameUpdate, opUpdate: I.DataGameUpdate) {
		let champ = this.activeChamps[data.uid];
		update.sourceUid = champ.getUid();

		if (!champ) {
			throw new Error('Invalid champion');
		}

		if (champ.getOwner() !== player.getId()) {
			throw new Error('Cannot move opponent champion');
		}

		opUpdate.enemySpawn.push(champ);
		delete opUpdate.moved;
		let drawnChamp = player.getDeck().drawChampion(player.getId());
		this.activeChamps[drawnChamp.getUid()] = drawnChamp;
		update.hand.push(drawnChamp);
	}
}

/**
* Representation of a player in the game
*/
export class Player {
	/** The player id */
	private id: string;

	/** The socket corresponding the player client */
	private sock: SocketIO.Socket;

	/** The health of the player */
	private health: number;

	/** The player's deck */
	private deck: Deck;

	/** The turn number until which that the player is invulnerable */
	private invulnTurn: number;

	/** The player's fountain */
	private fountain: {championId: number, championLevel: number, deathTimer: number}[];

	/** Whether the player is ready */
	private ready: boolean;

	/** The icon number of this player */
	public iconNumber: number;

	/**
	* @param playerId	the id of the this player
	* @param sock		the socket connected to the player's client
	*/
	constructor(playerId: string, sock: SocketIO.Socket) {
		this.id = playerId;
		this.sock = sock;
		this.health = constants.NEXUS_STARTING_HEALTH;
		this.deck = null;
		this.ready = false;
		this.invulnTurn = 0;  // Players cannot take damage until turn 3
		this.fountain = [];
		this.iconNumber = 0;
	}

	/**
	* @return the socket associated with this player
	*/
	public getSocket(): SocketIO.Socket {
		return this.sock;
	}

	/**
	* @return the id of the player
	*/
	public getId(): string {
		return this.id;
	}

	/**
	* @return the deck of the player
	*/
	public getDeck(): Deck {
		return this.deck;
	}

	/**
	* Updates the player's deck, and setting the player to be ready; if the given deck is null,
	* the player's ready state will not be updated
	* @param d	the deck to use for the player
	*/
	public setDeck(d: Deck): void {
		if (d) {
			this.deck = d;
			this.ready = true;
		}
	}

	/**
	* @return whether the player is ready
	*/
	public isReady(): boolean {
		return this.ready;
	}

	/**
	* Sets up the hand for the start of the game
	* @param count 			the number of cards to start off in the hand
	* @param activeChamps	a reference to the game's activeChampion dictionary
	*/
	public initializeHand(count: number, activeChamps: any): void {
		for (let i = 0; i < count; i++) {
			let c = this.deck.drawChampion(this.id);
			activeChamps[c.getUid()] = c;
		}
	}

	/**
	* @return the player's health
	*/
	public getHealth(): number {
		return this.health;
	}

	/**
	* @return the turn number until which the player is invulnerable
	*/
	public getInvulnTurn(): number {
		return this.invulnTurn;
	}

	/**
	* Applies damage to the player
	* @param dmg	the amount of damage to apply
	* @returns whether the player has been defeated
	*/
	public applyDamage(dmg: number): boolean {
		//this.health -= Math.min(dmg, this.health);
		this.health -= 1;
		return this.health === 0;
	}

	/**
	* Ticks the player's fountain, decrementing death timers and moving champions
	* to the deck if needed
	*/
	public tickFountain(): void {
		for (let i = 0; i < this.fountain.length; i++) {
			let curr = this.fountain[i];
			curr.deathTimer--;
			if (curr.deathTimer === 0) {
				this.fountain.splice(i, 1);
				this.deck.addChampion(curr.championId, curr.championLevel);
			}
		}
	}

	/**
	* Adds a champion to the player's fountain
	* @param champ the champion to send to the fountain
	*/
	public sendToFountain(champ: Champion): void {
		this.fountain.push({
			championId: champ.getChampId(),
			championLevel: champ.getChampLevel(),
			deathTimer: 5
		});
	}
}

/**
* Representation of a champion/card in the game
*/
export class Champion {
	protected champId: number;
	protected uid: string;
	protected champLevel: number;
	protected owner: string;
	protected health: number;
	protected maxHealth: number;
	protected dmg: number;
	protected ability: Ability;
	protected currentLocation: Location;
	protected stunnedTurn: number;
	protected invulnTurn: number;
	protected stasisTurn: number;
	protected damageReduction: number;
	protected shield: number;
	protected damageBuff: number;
	protected marked: boolean;
	protected statusEndTurn: {[status: number]: number};
	public movedNum: number;

	constructor(owner: string, champId: number, champLevel: number) {
		this.uid = generator.generateId(8);
		this.champId = champId;
		this.champLevel = champLevel;
		this.owner = owner;
		this.maxHealth = SC.StatComputer.getHealth(CT.ChampionTags.getTag(champId).primary, CT.ChampionTags.getTag(champId).secondary, champLevel);
		this.health = this.maxHealth;
		this.dmg = SC.StatComputer.getDamage(CT.ChampionTags.getTag(champId).primary, CT.ChampionTags.getTag(champId).secondary, champLevel);
		this.currentLocation = Location.Hand;
		this.stunnedTurn = 0;
		this.invulnTurn = 0;
		this.stasisTurn = 0;
		this.damageReduction = 0;
		this.shield = 0;
		this.damageBuff = 0;
		this.marked = false;
		this.statusEndTurn = {};
		this.ability = {
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				enemy.setStunnedTurn(game.getGameTurnNum() + 1);
				update.affected.push({uid: data.targetUid, status: I.Status.Stunned, turnNum: enemy.stunnedTurn});

				champ.movedNum = game.getTurnNum();

				return 5;
			},
			name: "Stun",
			description: "Stuns an opponent for 1 turn.",
			readyTurn: 0,
			type: AbilityType.SingleEnemySameLane
		}
	}

	/** Return true if enemy is killed */
	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.movedNum = turnNum;
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}

	public takeDamage(game: Game, damage: number, attacker: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.updateStatus(this, turnNum);
		let dmg = Math.round(damage * (1 + attacker.damageBuff) * (1 - this.damageReduction));
		if (this.shield > 0) {
			if (dmg > this.shield) {
				dmg -= this.shield;
				this.shield = 0;
			} else {
				this.shield -= damage;
				dmg = 0;
			}
		}
		this.health -= (Math.min(dmg, this.health));
		return this.health === 0;
	}

	public updateStatus(champ: Champion, turnNum: number): void {
		for (let index in this.statusEndTurn) {
			if (turnNum >= this.statusEndTurn[index]) {
				let currStatus: I.Status = parseInt(index);

				switch(currStatus) {
					case I.Status.DamageReduction:
						this.damageReduction = 0;
						break;
					case I.Status.Shielded:
						this.shield = 0;
						break;
					case I.Status.DamageBuff:
						this.damageBuff = 0;
						break;
					case I.Status.Marked:
						this.marked = false;
						break;
				}
			}
		}
	}

	public getHealth(): number {
		return this.health;
	}

	public getMaxHealth(): number {
		return this.maxHealth;
	}

	public addHealth(value: number): void {
		this.health += value;
		if (this.health > this.maxHealth) {
			this.health = this.maxHealth;
		}
	}

	public addMaxHealth(value: number): void {
		this.maxHealth += value;
	}

	public getDamage(): number {
		return this.dmg;
	}

	public addDamage(value: number): void {
		this.dmg += value;
	}

	public getChampId(): number {
		return this.champId;
	}

	public getChampLevel(): number {
		return this.champLevel;
	}

	public getUid(): string {
		return this.uid;
	}

	public getLocation(): Location {
		return this.currentLocation;
	}

	public setLocation(loc: Location, turnNum: number): void {
		this.movedNum = turnNum;
		this.currentLocation = loc;
	}

	public getOwner(): string {
		return this.owner;
	}

	public getStunnedTurn(): number {
		return this.stunnedTurn;
	}

	public setStunnedTurn(turnNum: number): void {
		this.stunnedTurn = turnNum;
	}

	public getInvulnTurn(): number {
		return this.invulnTurn;
	}

	public setInvulnTurn(turnNum: number): void {
		this.invulnTurn = turnNum;
	}

	public getStasisTurn(): number {
		return this.stasisTurn;
	}

	public setStasisTurn(turnNum: number): void {
		this.stasisTurn = turnNum;
	}

	public getDamageReduction(reduction: number): number {
		return this.damageReduction;
	}

	public setDamageReduction(turnNum: number, reduction: number, duration: number): void {
		this.statusEndTurn[I.Status.DamageReduction] = turnNum + duration;
		this.damageReduction = reduction;
	}

	public getShield(value: number): number {
		return this.shield;
	}

	public setShield(turnNum: number, value: number, duration: number): void {
		this.statusEndTurn[I.Status.Shielded] = turnNum + duration;
		this.shield = value;
	}

	public getDamageBuff(value: number): number {
		return this.damageBuff;
	}

	public setDamageBuff(turnNum: number, value: number, duration: number): void {
		this.statusEndTurn[I.Status.DamageBuff] = turnNum + duration;
		this.damageBuff = value;
	}

	public isMarked() {
		return this.marked;
	}

	public setMark(turnNum: number, duration: number): void {
		this.statusEndTurn[I.Status.Marked] = turnNum + duration;
	}

	public consumeMark(): void {
		this.marked = false;
	}
	public getAbility(): Ability {
		return this.ability;
	}
}

/**
* Representation of a champion ability
*/
export interface Ability {
	/** Reference to the game, a target (if applicable, and the update object); returns the cooldown */
	effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => number;
	/** Keeping track of the CURRENT cooldown. In otherwords, the turnNum when the ability will be re-enabled */
	readyTurn: number;
	/** Name of the ability */
	name: string;
	/** Description of the ability */
	description: string;
	/** Type of the ability */
	type: AbilityType
}

export enum AbilityType {
	None,
	Passive,
	Self,
	SingleEnemySameLane,
	SingleEnemyAnyLane,
	SingleAllySameLane,
	SingleAllyAnyLane,
	AOEEnemySameLane,
	AOEEnemyAnyLane,
	AOEAlly,
	GlobalAlly,
	GlobalEnemy
}

/**
* The possible locations for a champion
*/
export enum Location {
	None, // Do not use
	Hand,
	LaneTop,
	LaneMid,
	LaneBot,
	JungleTop,
	JungleBot
}

/**
* Representation of a player's deck in the game
*/
export class Deck {
	private summonerName: string;
	private summonerId: string;
	private champions: {championId: number, championLevel: number}[];

	constructor(summonerName: string, summonerId: number) {
		this.summonerName = summonerName;
		this.champions = [];
	}

	public static createDeck(summonerName: string, rawData: I.ChampionMinData[]): Deck {
		if (!rawData.length || rawData.length === 0) {
			return null;
		}

		let resultDeck = new Deck(summonerName, rawData[0].summonerId);
		for (let i = 0; i < rawData.length; i++) {
			resultDeck.addChampion(rawData[i].championId, rawData[i].championLevel);
		}
		return resultDeck;
	}

	public addChampion(championId: number, championLevel: number): void {
		this.champions.push({
			championId: championId,
			championLevel: championLevel
		});
	}

	public drawChampion(playerId: string): Champion {
		let champRaw = this.champions.splice(Math.floor(this.champions.length * Math.random()), 1)[0];
		return createChampionById(playerId, champRaw.championId, champRaw.championLevel);
	}

	public getSummonerName(): string {
		return this.summonerName;
	}
}


/*************************************************************
* Champion definitions
**************************************************************/
let championById: {[id: number]: any} = {};

function createChampionById(owner: string, champId: number, champLevel: number): Champion {
	let c = championById[champId];
	if (!c) {
		return new Champion(owner, champId, champLevel);
	} else {
		return new c(owner, champId, champLevel);
	}
}

/***********************************************************************
* Steps to adding a champion:
* 	1) Create a new class for the champion, and add a constructor
*	2) Define the ability in the constructor
*		a) name, description, type, readyTurn are all required
			- readyTurn is NOT the cooldown. Set it to 0.
*		b) If the ability is passive, set effect to null, and instead override the
*		   takeDamage or attackEnemy methods
*		c) If the ability is an active, define it in effect. You should return the cooldown here.
*			- MAKE SURE TO UPDATE THE update OBJECT!!!!!!
*			- YOU MUST ALSO INITIALIZE THE CORRESPONDING ARRAY
*	3) Add the class to the championById array at the index corresponding to the champion's ID number
*
*	Useful methods in game:
*		- getChamp(uid)
*		- getSameLaneAllyChamps(uid)
*		- getSameLaneEnemyChamps(uid)
*		- getAllAlliedChamps(uid)
*		- getAllEnemyChamps(uid)
*/

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//-----------------------------------------------------------   A   ------------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Aatrox extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.currentTurn = 0;
		this.ability = {
			name: 'Blood Thirst',
			description: 'Every third attack heals for 10% of max HP (' + Math.round(0.1 * this.maxHealth) + ').',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.currentTurn++;
		if (this.currentTurn === 3) {
			this.health = Math.min(this.maxHealth, Math.round(this.maxHealth * 0.1) + this.health);
			this.currentTurn = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[266] = Aatrox;


class Ahri extends Champion {
	private charmedTargetUid: string;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Charm',
			description: 'Charms a target. The last charmed target will deal 15% less damage to Ahri' +
						 'and take 50% (' + Math.round(.5 * this.dmg) + ') more damage from Ahri.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				this.charmedTargetUid = data.targetUid;

				champ.movedNum = game.getTurnNum();

				return 2;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (enemy.getUid() === this.charmedTargetUid) {
			dmg = Math.round(dmg * 1.5);
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}

	public takeDamage(game: Game, dmg: number, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		if (enemy.getUid() === this.charmedTargetUid) {
			dmg = Math.round(dmg * 0.85);
		}

		return super.takeDamage(game, dmg, enemy, turnNum, update);
	}
}
championById[103] = Ahri;


class Akali extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Shadow Dance',
			description: 'Akali\'s action for the turn resets on kill.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let killed = enemy.takeDamage(game, this.dmg, this, turnNum, update);
		if (killed) {
			this.movedNum = turnNum - 1;
		} else {
			this.movedNum = turnNum;
		}
		return killed;
	}
}
championById[84] = Akali;


class Alistar extends Champion {
	private abilityTurnNum: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.abilityTurnNum = 0;
		this.ability = {
			name: 'Unbreakable Will',
			description: 'Takes 50% reduced damage and deals 200% (' + 2 * this.dmg + ') damage for the next 3 turns.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				(<Alistar>champ).abilityTurnNum = game.getTurnNum() + 3;
				champ.movedNum = game.getTurnNum();
				champ.setDamageBuff(game.getTurnNum() + 1, 2, 3);
				update.affected.push({uid: champ.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				return 7;
			}
		};
	}
	public takeDamage(game: Game, dmg: number, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		if (turnNum <= this.abilityTurnNum) {
			dmg = Math.round(dmg * 0.5);
		}
		return super.takeDamage(game, dmg, enemy, turnNum, update);
	}
}
championById[12] = Alistar;


class Amumu extends Champion {
	private attackedTargetUid: string;
	private numAttacks: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.attackedTargetUid = "";
		this.numAttacks = 0;
		this.ability = {
			name: 'Cursed Touch',
			description: 'Each consecutive attack on the same target deals 15% bonus damage, up to 45%.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (this.attackedTargetUid === "") {
			this.attackedTargetUid = enemy.getUid();
		}
		if (enemy.getUid() === this.attackedTargetUid) {
			if (this.numAttacks < 3) {
				dmg = Math.round(dmg * Math.pow(1.15, this.numAttacks));
				this.numAttacks++;
			} else {
				dmg = Math.round(dmg * Math.pow(1.15, 3));
			}
		} else {
			this.attackedTargetUid = enemy.getUid();
			this.numAttacks = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[32] = Amumu;


class Anivia extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Frostbite',
			description: 'Anivia deals 50% (' + Math.round(.5 * this.dmg) + ') bonus damage to stunned targets',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;

		if (enemy.getStunnedTurn() >= turnNum) {
			dmg = Math.round(dmg * 1.5);
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[34] = Anivia;


class Annie extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Bear Hug',
			description: 'Deals ' + Math.round(0.8 * this.dmg) + ' damage and stuns enemies in the lane for 1 turn.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.8 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						enemy.setStunnedTurn(game.getTurnNum() + 1);
						update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 7;
			}
		};
	}
}
championById[1] = Annie;


class Ashe extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Enchanted Arrow',
			description: 'Deals ' + Math.round(1.1 * this.dmg) + ' damage and stuns the target. Can target enemy in any lane.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let ashe = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.1 * ashe.getDamage()), ashe, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: ashe.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: ashe.getUid() });
				}

				ashe.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[22] = Ashe;


class AurelionSol extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Starsurge',
			description: 'Deals ' + Math.round(0.8 * this.dmg) + ' damage and stuns all targetted enemies in any lane',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let aSol = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneAllyChamps(data.targetUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.8 * aSol.getDamage()), aSol, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: aSol.getUid() });
					} else {
						enemy.setStunnedTurn(game.getTurnNum() + 1);
						update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: aSol.getUid() });
					}
				}

				aSol.movedNum = game.getTurnNum();
				return 7;
			}
		};
	}
}
championById[136] = AurelionSol;


class Azir extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Emperor\'s Order',
			description: 'Deals ' + Math.round(1.1 * this.dmg) + ' damage plus 25% (' + Math.round(.25 * this.dmg) + ') bonus damage for every ally in the lane to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);
				let numAllies = game.getSameLaneAllyChamps(data.sourceUid).length;

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.1 * champ.getDamage() * Math.pow(1.25, numAllies)), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 7;
			}
		};
	}
}
championById[268] = Azir;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//-----------------------------------------------------------   B   ------------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Bard extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Tempered Fate',
			description: 'Enemies in the targeted lane enter stasis and become untargetable',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneAllyChamps(data.targetUid);

				for (let enemy of enemies) {
					enemy.setStasisTurn(game.getTurnNum() + 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Stasis, turnNum: enemy.getStasisTurn() });
				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[432] = Bard;


class Blitzcrank extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Rocket Grab',
			description: 'Pulls an enemy from any lane into the same lane as Blitzcrank and deals ' + Math.round(this.dmg * 1.5) + ' damage to target.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(champ.getDamage() * 1.5), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					enemy.setLocation(champ.getLocation(), game.getTurnNum());
					update.moved.push({
						uid: enemy.getUid(),
						location: enemy.getLocation()
					});
				}

				champ.movedNum = game.getTurnNum();

				return 6;
			}
		};
	}
}
championById[53] = Blitzcrank;


class Brand extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Pyroclasm',
			description: 'Deals ' + Math.round(1.1 * this.dmg) + ' damage plus 25% (' + Math.round(.25 * this.dmg) + ') bonus damage for every enemy in the lane to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);
				let numEnemies = game.getSameLaneEnemyChamps(data.sourceUid).length;

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(champ.getDamage() * 1.1) + Math.round(champ.getDamage() * Math.pow(1.25, numEnemies)), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[63] = Brand;


class Braum extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);

		this.ability = {
			name: 'Unbreakable',
			description: 'Reduce all incoming damage to Braum and his allies in the lane by 50% for 1 turn',
			type: AbilityType.AOEAlly,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let allies = game.getSameLaneAllyChamps(data.sourceUid);

				for (let ally of allies) {
					ally.setDamageReduction(game.getTurnNum() + 1, 0.5, 1);
					update.affected.push({ uid: ally.getUid(), status: I.Status.DamageReduction, turnNum: game.getTurnNum() + 1 });
				}
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[201] = Braum;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//-----------------------------------------------------------   C   ------------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Caitlin extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Ace in the Hole',
			description: 'Deals ' + Math.round(1.4 * this.dmg) + ' damage to a target in any lane',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[51] = Caitlin;


class Cassiopeia extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Petrifying Gaze',
			description: 'Deals ' + Math.round(0.8 + this.dmg) + ' damage and stuns enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.8 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						enemy.setStunnedTurn(game.getTurnNum() + 1);
						update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[69] = Cassiopeia;


class ChoGath extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Feast',
			description: 'Deals ' + Math.round(1.4 * this.dmg) + ' damage to a target. If this ability kills the target, Cho\'Gath permanently gains ' + Math.round(0.15 * this.maxHealth) + ' health.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					var healthInc = 0.15 * champ.getMaxHealth();
					champ.addMaxHealth(healthInc);
					champ.addHealth(healthInc);
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[31] = ChoGath;


class Corki extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Missile Barrage',
			description: 'Deals ' + Math.round(0.75 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.75 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 3;
			}
		};
	}
}
championById[42] = Corki;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    D    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Darius extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Noxian Guillotine',
			description: 'Deals ' + Math.round(0.7 * this.dmg) + ' plus 1% for every health the target is missing as bonus damage. This ability\'s cooldown is reset on kill.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				let dmg = Math.round(Math.round(champ.getDamage() * 0.7) + champ.getDamage() * (1 - (enemy.getHealth() / enemy.getMaxHealth())));
				let cd = 6;

				if (enemy.takeDamage(game, dmg, champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					cd = 1;
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return cd;
			}
		};
	}
}
championById[122] = Darius;


class Diana extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Crescent Strike',
			description: 'Deals ' + Math.round(1.25 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.25 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[131] = Diana;


class DrMundo extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Masochism',
			description: 'Deals damage equal to 20% of max health (' + Math.round(0.2 * this.maxHealth) + ') at the cost of 7% of max health (' + Math.round(0.07 * this.maxHealth) + ').',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(champ.getMaxHealth() * 0.2), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					if (champ.takeDamage(game, champ.getMaxHealth() * 0.07, champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: champ.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: champ.getUid(), health: champ.getHealth(), attacker: champ.getUid() });
					}

				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 1;
			}
		};
	}
}
championById[36] = DrMundo;


class Draven extends Champion {
	baseDmg: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.baseDmg = this.dmg;
		this.ability = {
			name: 'Mastery of Draven',
			description: 'Permanently gains 15% (' + Math.round(this.baseDmg * 0.15) + ') of base damage for every kill.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let killed = enemy.takeDamage(game, this.dmg, this, turnNum, update);
		if (killed) {
			this.addDamage(Math.round(this.baseDmg * 0.15));
		}
		this.movedNum = turnNum;
		return killed;
	}
}
championById[119] = Draven;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    E    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


class Ekko extends Champion {
	private prevHealth: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.prevHealth = this.health;
		this.ability = {
			name: 'Chronobreak',
			description: 'Restores health lost in the last turn',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);

				champ.addHealth(Math.max((this.prevHealth - champ.getHealth()), 0));
				champ.movedNum = game.getTurnNum();

				return 6;
			}
		};
	}

	public takeDamage(game: Game, dmg: number, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let killed = super.takeDamage(game, dmg, enemy, turnNum, update);
		this.prevHealth = this.health;
		return killed;
	}
}
championById[245] = Ekko;


class Elise extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Neurotoxin',
			description: 'Deals ' + Math.round(0.8 * this.dmg) + ' plus 15% of the target\'s current health',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				let dmg = Math.round(Math.round(champ.getDamage() * 0.8) + (enemy.getHealth() * 0.15));

				if (enemy.takeDamage(game, dmg, champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[60] = Elise;


class Evelynn extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Agony\'s Embrace',
			description: 'Deals ' + Math.round(.75 * this.dmg) + ' to all enemies in the lane and grants Evelynn a shield equal to 10% of max health (' + Math.round(.1 * this.maxHealth) + ') for every enemy in the lane for 1 turn',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);
				let numEnemies = game.getSameLaneEnemyChamps(data.sourceUid).length;

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.75 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}
				champ.setShield(game.getTurnNum() + 1, Math.round(champ.getMaxHealth() * Math.pow(1.1, numEnemies)), 1);
				update.affected.push({uid: champ.getUid(), status: I.Status.Shielded, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[28] = Evelynn;


class Ezreal extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Trueshot Barrage',
			description: 'Deals ' + Math.round(0.8 * this.dmg) + ' damage to all enemies in any targeted lane',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneAllyChamps(data.targetUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.8 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}
				champ.movedNum = game.getTurnNum();
				return 7;
			}
		};
	}
}
championById[81] = Ezreal;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    F    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


class Fiddlesticks extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Drain',
			description: 'Deals ' + Math.round(0.85 * this.dmg) + ' damage to a target and heals for the same amount).',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(0.85 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					champ.addHealth(Math.min(Math.round(0.85 * champ.getDamage()), champ.getHealth()));
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 3;
			}
		};
	}
}
championById[9] = Fiddlesticks;


class Fiora extends Champion {
	private attackedTargetUid: string;
	private numAttacks: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.attackedTargetUid = "";
		this.numAttacks = 0;
		this.ability = {
			name: 'Expose Weakness',
			description: 'Each consecutive attack on the same target deals 15% bonus damage, up to 60%.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (this.attackedTargetUid === "") {
			this.attackedTargetUid = enemy.getUid();
		}
		if (enemy.getUid() === this.attackedTargetUid) {
			if (this.numAttacks < 4) {
				dmg = Math.round(dmg * Math.pow(1.15, this.numAttacks));
				this.numAttacks++;
			} else {
				dmg = Math.round(dmg * Math.pow(1.15, 4));
			}
		} else {
			this.attackedTargetUid = enemy.getUid();
			this.numAttacks = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[114] = Fiora;


class Fizz extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Urchin Strike',
			description: 'Deals ' + Math.round(1.5 * this.dmg) + ' damage to a target.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.5 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 3;
			}
		};
	}
}
championById[105] = Fizz;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    G    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Galio extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Idol of Durand',
			description: 'Becomes the only targetable champion in the lane for 1 turn',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let allies = game.getSameLaneAllyChamps(data.sourceUid);

				for (let ally of allies) {
					if (ally.getUid() != champ.getUid()) {
						ally.setInvulnTurn(game.getTurnNum() + 1);
						update.affected.push({ uid: ally.getUid(), status: I.Status.Invulnerable, turnNum: game.getTurnNum() + 1 });
					}
				}
				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[105] = Galio;


class Gangplank extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Cannon Barrage',
			description: 'Deals ' + Math.round(0.75 * this.dmg) + ' to ' + Math.round(this.dmg) + ' damage to each enemy in any targeted lane',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneAllyChamps(data.targetUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, (Math.round((Math.random() * 0.26) + 0.75) * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[41] = Gangplank;



class Garen extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Demacian Justice',
			description: 'Deals ' + Math.round(0.7 * this.dmg) + ' plus 2% for every health the target is missing as bonus damage.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				let dmg = Math.round(Math.round(champ.getDamage() * 0.7) + champ.getDamage() * 2 * (1 - (enemy.getHealth() / enemy.getMaxHealth())));

				if (enemy.takeDamage(game, dmg, champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[86] = Garen;


class Gnar extends Champion {
	private numAttacks: number;
	private attackedTargetUid: string;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.numAttacks = 0;
		this.attackedTargetUid = "";
		this.ability = {
			name: 'Hyper',
			description: 'Every third attack on the same target deals bonus damage equal to 15% of the target\'s max health.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (this.attackedTargetUid === "") {
			this.attackedTargetUid = enemy.getUid();
		}
		if (enemy.getUid() === this.attackedTargetUid) {
			if (this.numAttacks < 3) {
				this.numAttacks++;
			} else {
				dmg += Math.round(0.15 * enemy.getMaxHealth());
			}
		} else {
			this.attackedTargetUid = enemy.getUid();
			this.numAttacks = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[150] = Gnar;


class Gragas extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Explosive Cask',
			description: 'Deals ' + Math.round(0.4 * this.dmg) + ' damage to all enemies in the lane and blasts one of the enemies to an adjacent lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);
				let blastOff = true;

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
						if (blastOff) {
							if (enemy.getLocation() === Location.LaneTop) {
								enemy.setLocation(Location.LaneMid, game.getTurnNum());
							} else if (enemy.getLocation() === Location.LaneMid) {
								let rng =  Math.floor(Math.random()) + 1
								if (rng === 1) {
									enemy.setLocation(Location.LaneTop, game.getTurnNum());
								} else {
									enemy.setLocation(Location.LaneBot, game.getTurnNum());
								}
							} else {
								enemy.setLocation(Location.LaneMid, game.getTurnNum());
							}
							update.moved.push({
								uid: enemy.getUid(),
								location: enemy.getLocation()
							});
							blastOff = false;
						}
					}

				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[79] = Gragas;


class Graves extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Buckshot',
			description: 'Deals ' + Math.round(0.85 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.85 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[104] = Graves;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    H    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


class Hecarim extends Champion {
	baseDmg: number;
	prevLocation: Location;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.prevLocation = this.currentLocation;
		this.baseDmg = this.dmg;
		this.ability = {
			name: 'Warpath',
			description: 'Permanently gains 15% (' + Math.round(this.baseDmg * 0.15) + ') of base damage every time Hecarim roams to another lane.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public setLocation(loc: Location, turnNum: number): void {
		if (this.prevLocation !== this.currentLocation) {
			this.addDamage(Math.round(0.15 * this.baseDmg));
			this.prevLocation = this.currentLocation;
		}
		this.movedNum = turnNum;
		this.currentLocation = loc;
	}
}
championById[120] = Hecarim;


class Heimerdinger extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Hextech Rockets',
			description: 'Deals ' + Math.round(0.95 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.95 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[74] = Heimerdinger;



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    I    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


class Illaoi extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Tentacle Smash',
			description: 'Deals ' + Math.round(0.95 * this.dmg) + ' to all enemies in the lane and heals Illaoi equal to 10% of max health (' + Math.round(.08 * this.maxHealth) + ') for every enemy in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);
				let numEnemies = game.getSameLaneEnemyChamps(data.sourceUid).length;

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.95 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}
				champ.addHealth(Math.round(champ.getMaxHealth() * Math.pow(1.1, numEnemies)));
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[420] = Illaoi;


class Irelia extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Hiten Style',
			description: 'For the next 3 turns, Irelia deals ' + (Math.round(0.3 * this.dmg)) + ' bonus damage on her attacks.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);

				champ.setDamageBuff(game.getTurnNum() + 1, 0.3, 3);
				update.affected.push({uid: champ.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[39] = Irelia;



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    J    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Janna extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Eye of the Storm',
			description: 'Shield self or ally for 20% of Janna\'s max health (' + Math.round(0.25 * this.maxHealth) + ') and increase target\'s damage by 25%.',
			type: AbilityType.SingleAllySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let target = game.getChamp(data.targetUid);
				target.setShield(game.getTurnNum() + 1, Math.round(0.2 * champ.getMaxHealth()), 1)
				update.affected.push({uid: target.getUid(), status: I.Status.Shielded, turnNum: game.getTurnNum() + 1});
				target.setDamageBuff(game.getTurnNum() + 1, 0.25, 1);
				update.affected.push({uid: target.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[40] = Janna;

class JarvanIV extends Champion {
	baseDmg: number;
	enemiesHit: string[];

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.enemiesHit = [];
		this.baseDmg = this.dmg;
		this.ability = {
			name: 'Martial Cadence',
			description: 'For each new target, Jarvan IV deals 20% of the target\'s current health as bonus damage.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (this.enemiesHit.indexOf(enemy.getUid()) < 0) {
			dmg += Math.round(0.2 * enemy.getHealth());
			this.enemiesHit.push(enemy.getUid());
		}

		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}


class Jax extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Grandmaster\'s Might',
			description: 'Every third attack deals 25% bonus damage (' + Math.round(0.25 * this.dmg) + ').',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
		this.currentTurn = 0;
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.currentTurn++;
		this.movedNum = turnNum;
		let dmg = this.dmg;
		if (this.currentTurn === 3) {
			dmg += Math.round(0.25 * this.dmg);
			this.currentTurn = 0;
		}
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[24] = Jax;


class Jayce extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Shock Blast',
			description: 'Deals ' + Math.round(1.5 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.5 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[126] = Jayce;



class Jhin extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.currentTurn = 0;
		this.ability = {
			name: 'Death in 4 Acts',
			description: 'Every fourth attack crits for 200% damage (' + Math.round(2 * this.dmg) + ').',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.currentTurn++;
		let dmg = this.dmg;
		if (this.currentTurn === 4) {
			dmg += Math.round(2 * this.dmg);
			this.currentTurn = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[202] = Jhin;


class Jinx extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'SMD Rocket',
			description: 'Deals ' + Math.round(0.6 * this.dmg) + ' damage plus 1% bonus damage for every missing health to all enemies in any targeted lane',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneAllyChamps(data.targetUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.6 * champ.getDamage()) + champ.getDamage() * Math.round(1 - (enemy.getHealth() / enemy.getMaxHealth())), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 7;
			}
		};
	}
}
championById[222] = Jinx;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    K    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


class Kalista extends Champion {
	private attackedTargetUid: string;
	private numAttacks: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.attackedTargetUid = "";
		this.numAttacks = 0;
		this.ability = {
			name: 'Rend',
			description: 'Deals ' + Math.round(0.6 * this.dmg) + 'damage plus 15% (' + Math.round(0.15 * this.dmg) + ') bonus damage for every spear in the target. Each consecutive attack onto a target adds a spear and all spears are consumed with the usage of this ability.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(0.6 * champ.getDamage()) + Math.round(Math.pow(1.15, this.numAttacks)), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}
				this.numAttacks = 0;
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		if (this.attackedTargetUid === "") {
			this.attackedTargetUid = enemy.getUid();
		}
		if (enemy.getUid() === this.attackedTargetUid) {
			this.numAttacks++;
		} else {
			this.attackedTargetUid = enemy.getUid();
			this.numAttacks = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[429] = Kalista;



class Karma extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Inner Flame',
			description: 'Deals ' + Math.round(1.15 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.15 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 3;
			}
		};
	}
}
championById[43] = Karma;


class Karthus extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: '\'R\'',
			description: 'Deals ' + Math.round(1.15 * this.dmg) + ' damage to all enemies',
			type: AbilityType.GlobalEnemy,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getAllEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.15 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[30] = Karthus;



class Kassadin extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Null Sphere',
			description: 'Deals ' + Math.round(1.5 * this.dmg) + ' damage to a target.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.5 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[38] = Kassadin;


class Katarina extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Phantom Dancers',
			description: 'Katarina\'s action for the turn resets on kill.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let killed = enemy.takeDamage(game, this.dmg, this, turnNum, update);
		if (killed) {
			this.movedNum = turnNum - 1;
		} else {
			this.movedNum = turnNum;
		}
		return killed;
	}
}
championById[55] = Katarina;


class Kayle extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Intervention',
			description: 'Cast invulnerability shield on self or ally for 1 turn',
			type: AbilityType.SingleAllySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let target = game.getChamp(data.targetUid);
				target.setInvulnTurn(game.getTurnNum() + 1);
				update.affected.push({uid: target.getUid(), status: I.Status.Invulnerable, turnNum: target.getInvulnTurn()});
				return 5;
			}
		};
	}
}
championById[10] = Kayle;


class Kennen extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.currentTurn = 0;
		this.ability = {
			name: 'Mark of the Storm',
			description: 'Every fourth attack stuns the target.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.currentTurn++;
		if (this.currentTurn === 4) {
			enemy.setStunnedTurn(turnNum + 1);
			update.affected.push({uid: enemy.getUid(), status: I.Status.Stunned, turnNum: turnNum + 1});
			this.currentTurn = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[85] = Kennen;


class KhaZix extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Taste Their Fear',
			description: 'Deals 150% ' + Math.round(1.5 * this.dmg) + ' to isolated targets.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg
		if (game.getSameLaneEnemyChamps(this.getUid()).length === 1) {
			dmg = Math.round(dmg * 1.5);
		}

		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[121] = KhaZix;


class Kindred extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Lamb\'s Respite',
			description: 'All allies in the lane become invulnerable',
			type: AbilityType.AOEAlly,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let allies = game.getSameLaneAllyChamps(data.targetUid);

				for (let ally of allies) {
					ally.setInvulnTurn(game.getTurnNum() + 1);
					update.affected.push({ uid: ally.getUid(), status: I.Status.Invulnerable, turnNum: ally.getInvulnTurn() });
				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[203] = Kindred;


class KogMaw extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Bio-Arcane Barrage',
			description: 'For the next 3 turns, Kog Maw deals bonus damage equal to 10% of the target\'s current health.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				champ.setDamageBuff(game.getTurnNum() + 1, 0, 4);
				update.affected.push({uid: champ.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (turnNum <= this.statusEndTurn[I.Status.DamageBuff] ) {
			dmg += Math.round(enemy.getMaxHealth() * 0.1);
		}

		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[96] = KogMaw;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    L    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class LeBlanc extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Sigil of Malice',
			description: 'Deals ' + Math.round(this.dmg * 1.1) + ' damage and marks the target. When LeBlanc attacks a marked target, the target takes 50% (' + Math.round(this.dmg * 5) + ' additional damage.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.1 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setMark(game.getTurnNum() + 1, 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Marked, turnNum: game.getTurnNum() + 2 });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}
				return 4;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (enemy.isMarked()) {
			dmg += Math.round(1.5 * dmg);
			enemy.consumeMark();
		}

		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[7] = LeBlanc;


class LeeSin extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Resonating Strike',
			description: 'Deals ' + Math.round(0.8 * this.dmg) + ' damage and marks a target. Lee Sin does 1.5% bonus damage for every missing health against a marked target.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				let dmg = Math.round(Math.round(champ.getDamage() * 0.8) + champ.getDamage() * 1.5 * (1 - (enemy.getHealth() / enemy.getMaxHealth())));

				if (enemy.takeDamage(game, dmg, champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setMark(game.getTurnNum() + 1, 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Marked, turnNum: game.getTurnNum() + 2 });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (enemy.isMarked()) {
			dmg += dmg + Math.round(1.015 * (enemy.getHealth() / enemy.getMaxHealth()));
			enemy.consumeMark();
		}

		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[64] = LeeSin;


class Leona extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Solar Flare',
			description: 'Deals ' + Math.round(1.5 * this.dmg) + ' damage and stuns all enemies in the lane for 1 turn.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.5 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						enemy.setStunnedTurn(game.getTurnNum() + 1);
						update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[89] = Leona;


class Lissandra extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Frozen Tomb',
			description: 'Deals ' + Math.round(1.4 * this.dmg) + ' to all enemies in the lane and enters stasis for 1 turn.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.5 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}
				champ.setStasisTurn(game.getTurnNum() + 1);
				update.affected.push({ uid: champ.getUid(), status: I.Status.Stasis, turnNum: champ.getStasisTurn() });

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[127] = Lissandra;


class Lucian extends Champion {
	private isBonusDamage: boolean;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Lightslinger',
			description: 'Every second attack deals ' + Math.round(0.15 * this.dmg) + ' bonus damage.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
		this.isBonusDamage = true;
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (this.isBonusDamage) {
			dmg = Math.round(dmg * 1.15);
		}
		this.isBonusDamage = !this.isBonusDamage;
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[236] = Lucian;


class Lulu extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Help, Pix!',
			description: 'Shield self or ally for (' + Math.round(0.25 * this.dmg) + ') and increase target\'s damage by 20% for 1 turn.',
			type: AbilityType.SingleAllySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let target = game.getChamp(data.targetUid);
				target.setShield(game.getTurnNum() + 1, Math.round(0.25* champ.getDamage()), 1);
				update.affected.push({uid: target.getUid(), status: I.Status.Shielded, turnNum: game.getTurnNum() + 1});
				target.setDamageBuff(game.getTurnNum() + 1, 0.2, 1);
				update.affected.push({uid: target.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[117] = Lulu;


class Lux extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Finales Funkeln',
			description: 'Deals ' + Math.round(1.35 * this.dmg) + ' damage to all enemies in any targeted lane.',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.35 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[99] = Lux;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    M    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Malphite extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Unstoppable Force',
			description: 'Deals ' + Math.round(1.6 * this.dmg) + ' damage and stuns all enemies in the lane for 1 turn.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.6 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						enemy.setStunnedTurn(game.getTurnNum() + 1);
						update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[54] = Malphite;


class Malzahar extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Nether Grasp',
			description: 'Deals ' + Math.round(1.3 * this.dmg) + ' damage to a target and stuns the target for 1 turn.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.3 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[90] = Malzahar;


class Maokai extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);

		this.ability = {
			name: 'Vengeful Maelstrom',
			description: 'Reduce all incoming damage to Maokai and his allies in the lane by 35% for 2 turns',
			type: AbilityType.AOEAlly,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let allies = game.getSameLaneAllyChamps(data.sourceUid);

				for (let ally of allies) {
					ally.setDamageReduction(game.getTurnNum() + 1, 0.35, 2);
					update.affected.push({ uid: ally.getUid(), status: I.Status.DamageReduction, turnNum: game.getTurnNum() + 1 });
				}
				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[57] = Maokai;


class MasterYi extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Highlander',
			description: 'Master Yi\'s action for the turn resets on kill.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let killed = enemy.takeDamage(game, this.dmg, this, turnNum, update);
		if (killed) {
			this.movedNum = turnNum - 1;
		} else {
			this.movedNum = turnNum;
		}
		return killed;
	}
}
championById[11] = MasterYi;


class MissFortune extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Bullet Time',
			description: 'Deals ' + Math.round(1.25 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.25 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[21] = MissFortune;


class Mordekaiser extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.currentTurn = 0;
		this.ability = {
			name: 'Mace of Spades',
			description: 'Morde\'s next three attacks deal ' + (Math.round(1.25 * this.dmg) + ', ' + (Math.round(1.5 * this.dmg) + (Math.round(2 * this.dmg) + ' respectively.') )),
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				this.currentTurn = 0;
				champ.setDamageBuff(game.getTurnNum() + 1, 0, 3); // Just for the status icon
				update.affected.push({uid: champ.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 7;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.currentTurn++;
		let dmg = this.dmg;
		if (this.currentTurn === 1) {
			dmg += Math.round(0.25 * this.dmg);
		}
		if (this.currentTurn === 2) {
			dmg += Math.round(0.5 * this.dmg);
		}
		if (this.currentTurn === 3) {
			dmg += Math.round(this.dmg);
		}

		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[82] = Mordekaiser;


class Morgana extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Dark Binding',
			description: 'Deals ' + Math.round(1.3 * this.dmg) + ' damage to a target and stuns the target for 1 turn.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.3 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[25] = Morgana;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    N    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Nami extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Ebb and Flow',
			description: 'Heals self or an ally for ' + Math.round(2 * this.dmg) + '.',
			type: AbilityType.SingleAllySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let target = game.getChamp(data.targetUid);

				target.addHealth(champ.getDamage() * 2);
				champ.movedNum = game.getTurnNum();
				return 3;
			}
		};
	}
}
championById[267] = Nami;


class Nasus extends Champion {
	dmgInc: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.dmgInc = 2;
		this.ability = {
			name: 'Siphoning Strike',
			description: 'Permanently gains ' + this.dmgInc + ' damage every attack',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		this.addDamage(this.dmgInc);
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[75] = Nasus;


class Nautilus extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Titan\'s Wrath',
			description: 'Gains a shield for 15% of Nautilus\' max health (' + Math.round(0.15 * this.maxHealth) + ') and increases damage by 25% for 1 turn.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				champ.setShield(game.getTurnNum() + 1, Math.round(0.15 * champ.getMaxHealth()), 1)
				update.affected.push({uid: champ.getUid(), status: I.Status.Shielded, turnNum: game.getTurnNum() + 1});
				champ.setDamageBuff(game.getTurnNum() + 1, 0.25, 1);
				update.affected.push({uid: champ.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[111] = Nautilus;


class Nidalee extends Champion {
	private baseHP: number;
	private baseDmg: number;
	private form: number;
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.baseHP = this.health;
		this.baseDmg = this.dmg;
		this.maxHealth = Math.round(0.75 * this.baseHP);
		this.health = Math.round(0.75 * this.baseHP);
		this.dmg = Math.round(1.25 * this.baseDmg);
		this.form = 0;
		this.ability = {
			name: 'Human/Cougar Form',
			description: 'Changes form. Human form has 125% damage and 75% max health. Cougar form has 75% damage and 125% max health. Transforming does not consume action.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {

				if (this.form === 0) {
					this.maxHealth = Math.round(0.75 * this.baseHP);
					this.health = Math.round(0.75 * this.baseHP);
					this.dmg = Math.round(1.25 * this.baseDmg);
					this.form = 1;
				} else {
					this.maxHealth = Math.round(1.25 * this.baseHP);
					this.health = Math.round(1.25 * this.baseHP);
					this.dmg = Math.round(0.75 * this.baseDmg);
					this.form = 0;
				}
				return 2;
			}
		};
	}
}
championById[76] = Nidalee;


class Nocturne extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Paranoia',
			description: 'Deals ' + Math.round(1.4 * this.dmg) + ' damage to a target anywhere and moves to the target\'s lane',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				champ.setLocation(enemy.getLocation(), game.getTurnNum());
				update.moved.push({
					uid: champ.getUid(),
					location: champ.getLocation()
				});

				if (enemy.takeDamage(game, Math.round(1.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 6;
			}
		};
	}
}
championById[56] = Nocturne;


class Nunu extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Ice Ball',
			description: 'Deals ' + Math.round(1.8 * this.dmg) + ' damage to a target.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.8 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 2;
			}
		};
	}
}
championById[20] = Nunu;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    O    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Olaf extends Champion {
	baseDmg: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.baseDmg = this.dmg;
		this.ability = {
			name: 'Berserker Rage',
			description: 'Deals ' + Math.round(0.1 * this.baseDmg) + ' bonus damage for every 5% of missing health.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		dmg += Math.round((this.baseDmg / 5) * (this.health / this.maxHealth));
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[2] = Olaf;


class Orianna extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Dissonance',
			description: 'Deals ' + Math.round(1.3 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.3 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[61] = Orianna;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    P    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Pantheon extends Champion {
	private numAttacks: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.numAttacks = 0;
		this.ability = {
			name: 'Aegis Protection',
			description: 'Blocks every 4th attack dealt to Pantheon',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public takeDamage(game: Game, dmg: number, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.numAttacks++;
		if (this.numAttacks === 4) {
			dmg = 0;
			this.numAttacks = 0;
		}

		return super.takeDamage(game, dmg, enemy, turnNum, update);
	}
}
championById[80] = Pantheon;


class Poppy extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Keeper\'s Verdict',
			description: 'Deals ' + Math.round(0.4 * this.dmg) + ' damage to all enemies in the lane and sends the enemies to an adjacent lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);
				let sendLoc = Location.LaneTop;

				if (champ.getLocation() === Location.LaneTop) {
					sendLoc = Location.LaneMid;
				} else if (champ.getLocation() === Location.LaneMid) {
					let rng =  Math.floor(Math.random()) + 1;
					if (rng === 1) {
						sendLoc = Location.LaneTop;
					} else {
						sendLoc = Location.LaneBot;
					}
				} else {
					sendLoc = Location.LaneMid;
				}

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
						enemy.setLocation(sendLoc, game.getTurnNum());
						update.moved.push({
							uid: enemy.getUid(),
							location: enemy.getLocation()
						});
					}

				}
				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[78] = Poppy;

class Quinn extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Behind Enemy Lines',
			description: 'Deals ' + Math.round(1.4 * this.dmg) + ' damage to a target anywhere and moves to the target\'s lane',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				champ.setLocation(enemy.getLocation(), game.getTurnNum());
				update.moved.push({
					uid: champ.getUid(),
					location: champ.getLocation()
				});

				if (enemy.takeDamage(game, Math.round(1.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 6;
			}
		};
	}
}
championById[133] = Quinn;



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    R    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Rammus extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Spiked Shell',
			description: 'Reflects 10% of damage dealt to Rammus back to the attacker',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public takeDamage(game: Game, dmg: number, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		enemy.takeDamage(game, Math.round(0.1 * dmg), this, turnNum, update);
		return super.takeDamage(game, dmg, enemy, turnNum, update);
	}
}
championById[33] = Rammus;


class RekSai extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Void Rush',
			description: 'Deals ' + Math.round(1.4 * this.dmg) + ' damage to a target anywhere and moves to the target\'s lane',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				champ.setLocation(enemy.getLocation(), game.getTurnNum());
				update.moved.push({
					uid: champ.getUid(),
					location: champ.getLocation()
				});

				if (enemy.takeDamage(game, Math.round(1.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 6;
			}
		};
	}
}
championById[421] = RekSai;


class Renekton extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Dominus',
			description: 'Renekton gains 20% of max health (' + Math.round(0.2 * this.maxHealth) + ' and deals AoE damage on attacks for 3 turns.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				champ.setDamageBuff(game.getTurnNum() + 1, 0, 4);
				let healthInc = Math.round(0.2 * this.maxHealth);
				champ.addHealth(healthInc);
				update.affected.push({uid: champ.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.movedNum = turnNum;
		if (turnNum <= this.statusEndTurn[I.Status.DamageBuff]) {
			let enemies = game.getSameLaneAllyChamps(enemy.getUid());
			for (let enemy2 of enemies) {
				if (enemy2.getUid() !== enemy.getUid()) {
					if (enemy2.takeDamage(game, this.dmg, this, turnNum, update)) {
						update.killed.push({ uid: enemy2.getUid(), killer: this.getUid() });
					} else {
						update.damaged.push({ uid: enemy2.getUid(), health: enemy2.getHealth(), attacker: this.getUid() });
					}
				}
			}
		}
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[58] = Renekton;


class Rengar extends Champion {
	baseDmg: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.baseDmg = this.dmg;
		this.ability = {
			name: 'Trophy Hunter',
			description: 'Permanently gains 15% (' + Math.round(this.baseDmg * 0.15) + ') of base damage for every kill.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let killed = enemy.takeDamage(game, this.dmg, this, turnNum, update);
		if (killed) {
			this.addDamage(Math.round(this.baseDmg * 0.15));
		}
		this.movedNum = turnNum;
		return killed;
	}
}
championById[107] = Rengar;


class Riven extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Windslash',
			description: 'Deals ' + Math.round(0.7 * this.dmg) + ' damage plus 1% bonus damage for every missing health to all enemies in the lane',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.9 * champ.getDamage()) + champ.getDamage() * Math.round(1 - (enemy.getHealth() / enemy.getMaxHealth())), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[92] = Riven;


class Rumble extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'The Equalizer',
			description: 'Deals ' + Math.round(1.2 * this.dmg) + ' to enemies in any targeted lane',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.2 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 7;
			}
		};
	}
}
championById[68] = Rumble;


class Ryze extends Champion {
	private numAttacks: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.numAttacks = 0;
		this.ability = {
			name: 'Arcane Mastery',
			description: 'Gains a shield every 4 attacks equal to ' + Math.round(0.15 * this.maxHealth) + ' that lasts 1 turn.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.numAttacks++;
		let dmg = this.dmg;
		if (this.numAttacks === 4) {
			this.setShield(turnNum + 1, Math.round(0.15 * this.maxHealth), 1);
			update.affected.push({uid: this.getUid(), status: I.Status.Shielded, turnNum: game.getTurnNum() + 1});
			this.numAttacks = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[13] = Ryze;



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    S    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class Sejuani extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Glacial Prison',
			description: 'Deals ' + Math.round(1.8 * this.dmg) + ' damage and stuns enemies in the lane for 1 turn.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.8 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						enemy.setStunnedTurn(game.getTurnNum() + 1);
						update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[113] = Sejuani;



class Shaco extends Champion {
	critChance: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.critChance = 1;
		this.ability = {
			name: 'Clown Fiesta',
			description: 'Permanently gains 10% crit chance (up to 50%) for every kill.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		let rng = Math.floor((Math.random()*10) + 1);
		if (rng <= this.critChance) {
			dmg = dmg * 2;
		}
		let killed = enemy.takeDamage(game, dmg, this, turnNum, update);
		if (killed) {
			this.critChance++;
			if (this.critChance > 5) {
				this.critChance = 5;
			}
		}
		this.movedNum = turnNum;
		return killed;
	}
}
championById[35] = Shaco;


class Shen extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Stand United',
			description: 'Teleports to an ally anywhere and shields the targeted ally for ' + Math.round(0.15 * this.maxHealth) + ' for 1 turn.',
			type: AbilityType.SingleAllyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let ally = game.getChamp(data.targetUid);
				champ.setLocation(ally.getLocation(), game.getTurnNum());
				update.moved.push({
					uid: champ.getUid(),
					location: champ.getLocation()
				});

				ally.setShield(game.getTurnNum() + 1, Math.round(champ.getMaxHealth() * 0.15), 1);
				update.affected.push({uid: ally.getUid(), status: I.Status.Shielded, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();

				return 6;
			}
		};
	}
}
championById[98] = Shen;



class Shyvana extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Dragon\'s Descent',
			description: 'Shyvana gains 20% of max health (' + Math.round(0.2 * this.maxHealth) + ' and deals AoE damage on attacks for 3 turns.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				champ.setDamageBuff(game.getTurnNum() + 1, 0, 4);
				let healthInc = Math.round(0.2 * this.maxHealth);
				champ.addHealth(healthInc);
				update.affected.push({uid: champ.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.movedNum = turnNum;
		if (turnNum <= this.statusEndTurn[I.Status.DamageBuff]) {
			let enemies = game.getSameLaneAllyChamps(enemy.getUid());
			for (let enemy2 of enemies) {
				if (enemy2.getUid() !== enemy.getUid()) {
					if (enemy2.takeDamage(game, this.dmg, this, turnNum, update)) {
						update.killed.push({ uid: enemy2.getUid(), killer: this.getUid() });
					} else {
						update.damaged.push({ uid: enemy2.getUid(), health: enemy2.getHealth(), attacker: this.getUid() });
					}
				}
			}
		}
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[102] = Shyvana;


class Singed extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Poison Trail',
			description: 'Singed deals AoE damage on attacks to all enemies in the lane',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.movedNum = turnNum;
		if (turnNum <= this.statusEndTurn[I.Status.DamageBuff]) {
			let enemies = game.getSameLaneAllyChamps(enemy.getUid());
			for (let enemy2 of enemies) {
				if (enemy2.getUid() !== enemy.getUid()) {
					if (enemy2.takeDamage(game, this.dmg, this, turnNum, update)) {
						update.killed.push({ uid: enemy2.getUid(), killer: this.getUid() });
					} else {
						update.damaged.push({ uid: enemy2.getUid(), health: enemy2.getHealth(), attacker: this.getUid() });
					}
				}
			}
		}
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[27] = Singed;


class Sion extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Unstoppable Onslaught',
			description: 'Moves to the target\'s lane and deals ' + Math.round(1.6 * this.dmg) + ' damage and stuns the target.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				champ.setLocation(enemy.getLocation(), game.getTurnNum());
				update.moved.push({
					uid: champ.getUid(),
					location: champ.getLocation()
				});

				if (enemy.takeDamage(game, Math.round(1.6 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn()});
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 6;
			}
		};
	}
}
championById[14] = Sion;


class Sivir extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Boomerang Blade',
			description: 'Deals ' + Math.round(0.85 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.85 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[15] = Sivir;



class Skarner extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Impale',
			description: 'Deals ' + Math.round(1.8 * this.dmg) + ' damage to a target and stuns the target for 1 turn.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.8 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();
				return 3;
			}
		};
	}
}
championById[72] = Skarner;


class Sona extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Power Chord',
			description: 'Provides an aura that increases lane allies\' damage by 20% for 2 turns.',
			type: AbilityType.SingleAllySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let target = game.getChamp(data.targetUid);
				target.setDamageBuff(game.getTurnNum() + 1, 0.2, 2);
				update.affected.push({uid: target.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[37] = Sona;


class Soraka extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Wish',
			description: 'Heals all allies for 25% of Soraka\'s current health (' + Math.round(0.25 * this.health) + '). Focus Soraka.',
			type: AbilityType.GlobalAlly,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let allies = game.getAllAlliedChamps(data.sourceUid);

				for (let ally of allies) {
					ally.addHealth(Math.round(0.25 * this.health));
				}

				this.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}

class Swain extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Ravenous Flock',
			description: 'Deals ' + Math.round(.75 * this.dmg) + ' to all enemies in the lane and heals Swain for 50% of the total damage dealt.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);
				let numEnemies = game.getSameLaneEnemyChamps(data.sourceUid).length;

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.75 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}
				champ.addHealth(Math.round(Math.round(0.5*(0.75 * champ.getDamage() * numEnemies))));
				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[50] = Swain;


class Syndra extends Champion {
		private numAttacks: number;
		constructor(owner: string, champId: number, champLevel: number) {
			super(owner, champId, champLevel);
			this.numAttacks = 0;
			this.ability = {
			name: 'Unleashed Power',
			description: 'Deals ' + Math.round(1.2 * this.dmg) + 'damage plus 20% (' + Math.round(0.2 * this.dmg) + ') bonus damage for every Dark Sphere (up to 5). Every attack produces a Dark Sphere and is consumed with the usage of this ability.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.2 * champ.getDamage()) + Math.round(Math.pow(1.2, this.numAttacks)), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}
				this.numAttacks = 0;
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.numAttacks++;
		if (this.numAttacks > 5) {
			this.numAttacks = 5;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[134] = Syndra;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//----------------------------------------------------------    T    -----------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

class TahmKench extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Devour',
			description: 'Makes the targeted ally untargetable.',
			type: AbilityType.SingleAllySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let target = game.getChamp(data.targetUid);
				target.setInvulnTurn(game.getTurnNum() + 1);
				update.affected.push({uid: target.getUid(), status: I.Status.Invulnerable, turnNum: target.getInvulnTurn()});
				return 4;
			}
		};
	}
}
championById[223] = TahmKench;


class Talon extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Rake',
			description: 'Deals ' + Math.round(0.85 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.85 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[91] = Talon;


class Taric extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Starlight Touch',
			description: 'Heals allies in the lane for ' + Math.round(0.15 * this.dmg) + '.',
			type: AbilityType.AOEAlly,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let allies = game.getSameLaneAllyChamps(data.sourceUid);

				for (let ally of allies) {
					ally.addHealth(Math.round(0.15 * this.dmg));
				}

				champ.movedNum = game.getTurnNum();
				return 3;
			}
		};
	}
}
championById[44] = Taric;

class Teemo extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Teeto',
			description: 'Grants vision of the surrounding area while active.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}
}
championById[17] = Teemo;

class Thresh extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Dark Passage',
			description: 'Pulls an ally from any lane into the same lane as Thresh.',
			type: AbilityType.SingleAllyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let thresh = game.getChamp(data.sourceUid);
				let ally = game.getChamp(data.targetUid);
				ally.setLocation(thresh.getLocation(), game.getTurnNum());

				update.moved.push({
					uid: ally.getUid(),
					location: ally.getLocation()
				});

				thresh.movedNum = game.getTurnNum();

				return 7;
			}
		};
	}
}
championById[412] = Thresh;

class Tristana extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Hot Rocket',
			description: 'Tristana\'s action for the turn resets on kill.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let killed = enemy.takeDamage(game, this.dmg, this, turnNum, update);
		if (killed) {
			this.movedNum = turnNum - 1;
		} else {
			this.movedNum = turnNum;
		}
		return killed;
	}
}
championById[18] = Tristana;


class Trundle extends Champion {
	private subbedTargetUid: string;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.subbedTargetUid = "";
		this.ability = {
			name: 'Subjugate',
			description: 'The last subjugated target will deal 20% less damage to Trundle' +
						 'and take 50% (' + Math.round(.5 * this.dmg) + ') more damage from Trundle.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				this.subbedTargetUid = data.targetUid;

				champ.movedNum = game.getTurnNum();

				return 3;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (enemy.getUid() === this.subbedTargetUid) {
			dmg = Math.round(dmg * 1.5);
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}

	public takeDamage(game: Game, dmg: number, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		if (enemy.getUid() === this.subbedTargetUid) {
			dmg = Math.round(dmg * 0.8);
		}

		return super.takeDamage(game, dmg, enemy, turnNum, update);
	}
}
championById[48] = Trundle;


class Tryndamere extends Champion {
	baseDmg: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.baseDmg = this.dmg;
		this.ability = {
			name: 'Battle Fury',
			description: 'Deals ' + Math.round(0.1 * this.baseDmg) + ' bonus damage for every 5% of missing health.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		dmg += Math.round((this.baseDmg / 5) * (this.health / this.maxHealth));
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[23] = Tryndamere;


class TwistedFate extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Unstoppable Onslaught',
			description: 'Moves to the target\'s lane and deals ' + Math.round(1.4 * this.dmg) + ' damage and stuns the target.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				champ.setLocation(enemy.getLocation(), game.getTurnNum());
				update.moved.push({
					uid: champ.getUid(),
					location: champ.getLocation()
				});

				if (enemy.takeDamage(game, Math.round(1.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn()});
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 6;
			}
		};
	}
}
championById[4] = TwistedFate;


class Twitch extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Spray and Pray',
			description: 'Twitch\'s attacks deal AoE damage for 3 turns.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				champ.setDamageBuff(game.getTurnNum() + 1, 0, 4);
				update.affected.push({uid: champ.getUid(), status: I.Status.DamageBuff, turnNum: game.getTurnNum() + 1});
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.movedNum = turnNum;
		if (turnNum <= this.statusEndTurn[I.Status.DamageBuff]) {
			let enemies = game.getSameLaneAllyChamps(enemy.getUid());
			for (let enemy2 of enemies) {
				if (enemy2.getUid() !== enemy.getUid()) {
					if (enemy2.takeDamage(game, this.dmg, this, turnNum, update)) {
						update.killed.push({ uid: enemy2.getUid(), killer: this.getUid() });
					} else {
						update.damaged.push({ uid: enemy2.getUid(), health: enemy2.getHealth(), attacker: this.getUid() });
					}
				}
			}
		}
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[29] = Twitch;


class Udyr extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Unstoppable Onslaught',
			description: 'Deals ' + Math.round(1.6 * this.dmg) + ' damage and stuns the target.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.6 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn()});
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 4;
			}
		};
	}
}
championById[77] = Udyr;


class Urgot extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Position Reverser',
			description: 'Swaps places with target enemy and stuns the target.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				let champLoc = champ.getLocation();
				let enemyLoc = enemy.getLocation();

				enemy.setLocation(champLoc, game.getTurnNum());
				champ.setLocation(enemyLoc, game.getTurnNum());
				update.moved.push({
					uid: enemy.getUid(),
					location: enemy.getLocation()
				});
				update.moved.push({
					uid: champ.getUid(),
					location: champ.getLocation()
				});
				enemy.setStunnedTurn(game.getTurnNum() + 1);
				update.affected.push({uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn()});
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[6] = Urgot;


class Varus extends Champion {
		private numAttacks: number;
		constructor(owner: string, champId: number, champLevel: number) {
			super(owner, champId, champLevel);
			this.numAttacks = 0;
			this.ability = {
			name: 'Blight Pierce',
			description: 'Deals ' + Math.round(0.9 * this.dmg) + 'damage plus 15% (' + Math.round(0.15 * this.dmg) + ') bonus damage for every blight stack (up to 3). Every attack applies blight stacks and are consumed with the usage of this ability.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(7 * champ.getDamage()) + Math.round(Math.pow(1.15, this.numAttacks)), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}
				this.numAttacks = 0;
				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.numAttacks++;
		if (this.numAttacks > 3) {
			this.numAttacks = 3;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[110] = Varus;


class Vayne extends Champion {
	private numAttacks: number;
	private attackedTargetUid: string;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.numAttacks = 0;
		this.attackedTargetUid = "";
		this.ability = {
			name: 'Silver Bolts',
			description: 'Every third attack on the same target deals bonus damage equal to 15% of the target\'s max health.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (this.attackedTargetUid === "") {
			this.attackedTargetUid = enemy.getUid();
		}
		if (enemy.getUid() === this.attackedTargetUid) {
			if (this.numAttacks < 3) {
				this.numAttacks++;
			} else {
				dmg += Math.round(0.15 * enemy.getMaxHealth());
			}
		} else {
			this.attackedTargetUid = enemy.getUid();
			this.numAttacks = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[67] = Vayne;


class Veigar extends Champion {
	dmgInc: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.dmgInc = 2;
		this.ability = {
			name: 'Phenomental Evil Power',
			description: 'Permanently gains ' + this.dmgInc + ' damage every attack',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		this.addDamage(this.dmgInc);
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[45] = Veigar;


class VelKoz extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Deconstruction',
			description: 'Every third attack deals 25% bonus damage (' + Math.round(0.25 * this.dmg) + ').',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
		this.currentTurn = 0;
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.currentTurn++;
		this.movedNum = turnNum;
		let dmg = this.dmg;
		if (this.currentTurn === 3) {
			dmg += Math.round(0.25 * this.dmg);
			this.currentTurn = 0;
		}
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[161] = VelKoz;


class Vi extends Champion {
	private numAttacks: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.numAttacks = 0;
		this.ability = {
			name: 'Blast Shield',
			description: 'Gains a shield every 3 attacks equal to ' + Math.round(0.1 * this.maxHealth) + ' that lasts 1 turn.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.numAttacks++;
		let dmg = this.dmg;
		if (this.numAttacks === 3) {
			this.setShield(turnNum + 1, Math.round(0.15 * this.maxHealth), 1);
			update.affected.push({uid: this.getUid(), status: I.Status.Shielded, turnNum: game.getTurnNum() + 1});
			this.numAttacks = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[254] = Vi;


class Viktor extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Crescent Strike',
			description: 'Deals ' + Math.round(1.25 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.25 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[112] = Viktor;


class Vladimir extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Transfusion',
			description: 'Deals ' + Math.round(1.5 * this.dmg) + ' damage to a target and heals for half the amount).',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.5 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					champ.addHealth(Math.min(Math.round(0.75 * champ.getDamage()), champ.getHealth()));
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 4;
			}
		};
	}
}
championById[8] = Vladimir;


class Volibear extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Frenzy Bite',
			description: 'Deals ' + Math.round (1.2 * this.dmg) + ' damage plus bonus damage equal to 20% of current health (' + Math.round(0.2 * this.health) + ' to the target.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.2 * this.dmg) + Math.round(champ.getHealth() * 0.2), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 4;
			}
		};
	}
}
championById[106] = Volibear;


class Warwick extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Nether Grasp',
			description: 'Deals ' + Math.round(1.7 * this.dmg) + ' damage to a target and stuns the target for 1 turn.',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.7 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[19] = Warwick;


class Wukong extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Crushing Blow',
			description: 'Deals ' + Math.round (2.1 * this.dmg) + ' damage to the target.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, 2.1 * this.dmg, champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}

				champ.movedNum = game.getTurnNum();

				return 4;
			}
		};
	}
}
championById[62] = Wukong;


class Xerath extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Rite of the Arcane',
			description: 'Deals ' + Math.round(1.2 * this.dmg) + ' damage to all enemies in any targeted lane',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.2 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[101] = Xerath;


class XinZhao extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.currentTurn = 0;
		this.ability = {
			name: 'Blood Thirst',
			description: 'Every third attack heals for 10% of max HP (' + Math.round(0.1 * this.maxHealth) + ').',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		this.currentTurn++;
		if (this.currentTurn === 3) {
			this.health = Math.min(this.maxHealth, Math.round(this.maxHealth * 0.1) + this.health);
			this.currentTurn = 0;
		}
		this.movedNum = turnNum;
		return enemy.takeDamage(game, this.dmg, this, turnNum, update);
	}
}
championById[5] = XinZhao;


class Yasuo extends Champion {
	critChance: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.critChance = 35;
		this.ability = {
			name: 'Way of the Wanderer',
			description: 'Has 35% chance to crit for 150% damage',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		}
	};

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		let rng = Math.floor((Math.random()*100) + 1);
		if (rng <= this.critChance) {
			dmg = dmg * 1.5;
		}
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[157] = Yasuo;


class Yorick extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Omen of Famine',
			description: 'Deals ' + Math.round(1.3 * this.dmg) + ' damage to a target and heals for 75% of the amount).',
			type: AbilityType.SingleEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(1.3 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					champ.addHealth(Math.min(Math.round(0.75 * (1.3 * champ.getDamage())), champ.getHealth()));
				} else {
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}


				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}
}
championById[83] = Yorick;


class Zac extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Unstable Matter',
			description: 'Deals damage equal to 15% of max health (' + Math.round(0.15 * this.maxHealth) + ') to all enemies in the lane at the cost of 7% of max health (' + Math.round(0.07 * this.maxHealth) + ').',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(0.15 * this.maxHealth), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
						if (champ.takeDamage(game, champ.getMaxHealth() * 0.07, champ, game.getTurnNum(), update)) {
							update.killed.push({ uid: champ.getUid(), killer: champ.getUid() });
						} else {
							update.damaged.push({ uid: champ.getUid(), health: champ.getHealth(), attacker: champ.getUid() });
						}
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}
				}

				champ.movedNum = game.getTurnNum();

				return 2;
			}
		};
	}
}
championById[154] = Zac;


class Zed extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Death Mark',
			description: 'Deals ' + Math.round(this.dmg * 0.85) + ' damage and marks the target. When Zed attacks a marked target, the target takes 50% (' + Math.round(this.dmg * 5) + ' additional damage.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(game, Math.round(0.85 * champ.getDamage()), champ, game.getTurnNum(), update)) {
					update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
				} else {
					enemy.setMark(game.getTurnNum() + 1, 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Marked, turnNum: game.getTurnNum() + 1 });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
				}
				return 5;
			}
		};
	}

	public attackEnemy(game: Game, enemy: Champion, turnNum: number, update: I.DataGameUpdate): boolean {
		let dmg = this.dmg;
		if (enemy.isMarked()) {
			dmg += Math.round(1.5 * dmg);
			enemy.consumeMark();
		}

		this.movedNum = turnNum;
		return enemy.takeDamage(game, dmg, this, turnNum, update);
	}
}
championById[238] = Zed;


class Ziggs extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Mega Inferno Bomb',
			description: 'Deals ' + Math.round(1.4 * this.dmg) + ' damage to all enemies in any targeted lane',
			type: AbilityType.AOEEnemyAnyLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneAllyChamps(data.targetUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.4 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 6;
			}
		};
	}
}
championById[115] = Ziggs;


class Zyra extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Deadly Spines',
			description: 'Deals ' + Math.round(1.33 * this.dmg) + ' damage to all enemies in the lane.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let champ = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(game, Math.round(1.33 * champ.getDamage()), champ, game.getTurnNum(), update)) {
						update.killed.push({ uid: enemy.getUid(), killer: champ.getUid() });
					} else {
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: champ.getUid() });
					}

				}

				champ.movedNum = game.getTurnNum();
				return 5;
			}
		};
	}

}
championById[143] = Zyra;
