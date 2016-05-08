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
			this.players.splice(this.players.indexOf(newPlayer), 1);
			this.gameState = GameState.Over;
			this.emitAll('gameover', { reason: 'Player disconnected' });
			if (this.isGameEmpty()) {
				gm.GamesManager.getInstance().removeGame(this.gameId);
			}
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

				Logger.log(Logger.Tag.Game, 'Attempting to load deck \'' + msg.summonerName + '\' for player ' + player.getId(), this.gameId);

				// Get the summoner id from name, then load mastery data, then load the deck.
				// If all players are loaded, initialize the game.
				fetcher.getSummonerId(msg.summonerName)
						.then(fetcher.getSummonerDeck)
						.then((value: I.ChampionMinData[]) => {
							player.setDeck(Deck.createDeck(msg.summonerName, value));

							Logger.log(Logger.Tag.Game, 'Successfully loaded deck \'' + msg.summonerName + '\' for player ' + player.getId(), this.gameId);

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

							}
						}).catch((err) => {
							player.getSocket().emit('gameerror', {reason: "Failed to load deck."});
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
		for (let i = 0; i < this.players.length; i++) {
			this.players[i].initializeHand(5, this.activeChamps);
			this.players[i].getSocket().emit('gameinit', {
				hand: this.getHand(this.players[i].getId()),
				starter: this.getCurrentTurnPlayerId(),
				nexusHealth: constants.NEXUS_STARTING_HEALTH
			});
		}
	}

	/**
	* Handles the transition from the Started stage to the Over stage
	*/
	private onGameOver(player: Player): void {
		console.log('game over: winner is ' + player.getId());
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
			affected: []
		};

		if (player.getId() !== this.getCurrentTurnPlayerId()) {
			player.getSocket().emit('gameerror', {
				reason: 'It is not your turn to make a move.',
			});
			return;
		}

		let wasFromHand = false;

		try {
			if (move.attackNexus) {
				this.tryAttackNexus(player, move.attackNexus, update);
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

	private tryAttackNexus(player: Player, data: any, update: I.DataGameUpdate): void {
		let source = this.activeChamps[data.uid];
		update.sourceUid = source.getUid();

		if (source.getLocation() === Location.Hand) {
			throw new Error('Cannot attack from hand');
		}

		if (source.getStunnedTurn() >= this.turnNum) {
			throw new Error('This champion is stunned.');
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

		// If opponent health is zero, end the game
		if (opp.applyDamage(source.getDamage())) {
			this.onGameOver(player);
		}

		source.movedNum = this.turnNum;
		update.movedNum = source.movedNum;

		// Add data to update object
		update.nexus[opp.getId()] = opp.getHealth();
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

		if (target.getInvulnTurn() >= this.turnNum) {
			throw new Error('Target is invulnerable');
		}

		if (source.getStunnedTurn() >= this.turnNum) {
			throw new Error('Cannot attack while stunned');
		}

		// Keep track of health in case of lifesteal
		let originalHealth = source.getHealth();

		// If enemy is killed, send to fountain
		if (source.attackEnemy(target, this.getTurnNum())) {
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

		source.movedNum = this.turnNum;
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

		if (champ.getAbility().readyTurn >= this.turnNum) {
			throw new Error('Ability is on cooldown');
		}

		if (champ.movedNum >= this.turnNum) {
			throw new Error('Champion has already made a move this turn');
		}

		champ.getAbility().readyTurn = champ.getAbility().effect(this, data, update) + this.turnNum;
		champ.movedNum = this.turnNum;
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

		let wasFromHand: boolean = champ.getLocation() === Location.Hand;

		champ.movedNum = this.turnNum;
		update.movedNum = champ.movedNum;

		champ.setLocation(data.targetLocation);
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
		this.invulnTurn = 3;  // Players cannot take damage until turn 3
		this.fountain = [];
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
		this.ability = {
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let enemy = game.getChamp(data.targetUid);
				enemy.setStunnedTurn(game.getGameTurnNum() + 1);
				update.affected.push({uid: data.targetUid, status: I.Status.Stunned, turnNum: enemy.stunnedTurn});
				return 5;
			},
			name: "Stun",
			description: "Stuns an opponent for one turn.",
			readyTurn: 0,
			type: AbilityType.SingleEnemySameLane
		}
	}

	/** Return true if enemy is killed */
	public attackEnemy(enemy: Champion, turnNum: number): boolean {
		return enemy.takeDamage(this.dmg, this, turnNum);
	}

	public takeDamage(damage: number, attacker: Champion, turnNum: number): boolean {
		this.health -= Math.min(damage, this.health);
		return this.health === 0;
	}

	public getHealth(): number {
		return this.health;
	}

	public getMaxHealth(): number {
		return this.maxHealth;
	}

	public getDamage(): number {
		return this.dmg;
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

	public setLocation(loc: Location): void {
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
*		   takeDamage or attackChamp methods
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
//------------------------------------------------------------- A --------------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
class Aatrox extends Champion {
	private currentTurn: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Blood Thirst',
			description: 'Every third attack heals for 10% of max HP (' + Math.round(0.1 * this.maxHealth) + ').',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
		this.currentTurn = 0;
	}

	public attackEnemy(enemy: Champion, turnNum: number): boolean {
		this.currentTurn++;
		if (this.currentTurn === 3) {
			this.health = Math.min(this.maxHealth, Math.round(this.maxHealth * 0.1) + this.health);
			this.currentTurn = 0;
		}
		return enemy.takeDamage(this.dmg, this, turnNum);
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
						 'and take 15% (' + Math.round(.15 * this.dmg) + ') more damage from Ahri.',
			type: AbilityType.SingleEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let ahri = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);
				this.charmedTargetUid = data.targetUid;

				ahri.movedNum = game.getTurnNum();
				update.movedNum = ahri.movedNum;

				return 1;
			}
		};
	}

	public attackEnemy(enemy: Champion, turnNum: number): boolean {
		let dmg = this.dmg;

		if (enemy.getUid() === this.charmedTargetUid) {
			dmg = Math.round(dmg * 1.15);
		}
		return enemy.takeDamage(dmg, this, turnNum);
	}

	public takeDamage(dmg: number, enemy: Champion, turnNum: number): boolean {
		if (enemy.getUid() === this.charmedTargetUid) {
			dmg = Math.round(dmg * 0.85);
		}
		this.health = Math.max(0, this.health - dmg);

		return this.health === 0;
	}
}
championById[103] = Ahri;


class Akali extends Champion {

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Shadow Dance',
			description: 'Akali\'s move for the turn resets on kill.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackChamp(enemy: Champion, turnNum: number): boolean {
		let killed = enemy.takeDamage(this.dmg, this, turnNum);
		if (killed) {
			this.movedNum = turnNum - 1;
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
			description: 'Take 50% reduced damage for the next 3 turns.',
			type: AbilityType.Self,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let alistar = game.getChamp(data.sourceUid);
				(<Alistar>alistar).abilityTurnNum = game.getTurnNum() + 3;
				alistar.movedNum = game.getTurnNum();
				update.movedNum = alistar.movedNum;

				return 7;
			}
		};
	}
	public takeDamage(dmg: number, enemy: Champion, turnNum: number): boolean {
		if (turnNum <= this.abilityTurnNum) {
			dmg = Math.round(dmg * 0.5);
		}
		this.health = Math.max(0, this.health - dmg);
		return this.health === 0;
	}
}
championById[12] = Alistar;


class Amumu extends Champion {
	private attackedTargetUid: string;
	private numAttacks: number;

	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.numAttacks = 0;
		this.ability = {
			name: 'Cursed Touch',
			description: 'Each consecutive attack on the same target deals 15% bonus damage, up to 45%.',
			type: AbilityType.Passive,
			readyTurn: 0,
			effect: null
		};
	}

	public attackEnemy(enemy: Champion, turnNum: number): boolean {
		let dmg = this.dmg;

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
		return enemy.takeDamage(dmg, this, turnNum);
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

	public attackEnemy(enemy: Champion, turnNum: number): boolean {
		let dmg = this.dmg;

		if (enemy.getStunnedTurn() >= turnNum) {
			dmg = Math.round(dmg * 1.5);
		}
		return enemy.takeDamage(dmg, this, turnNum);
	}
}
championById[34] = Anivia;


class Annie extends Champion {
	constructor(owner: string, champId: number, champLevel: number) {
		super(owner, champId, champLevel);
		this.ability = {
			name: 'Bearhug',
			description: 'Deals ' + Math.round(0.8 * this.dmg) + ' damage and stuns all enemies in the lane for 1 turn.',
			type: AbilityType.AOEEnemySameLane,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let annie = game.getChamp(data.sourceUid);
				let enemies = game.getSameLaneEnemyChamps(data.sourceUid);

				for (let enemy of enemies) {
					if (enemy.takeDamage(0.8 * annie.getDamage(), annie, game.getTurnNum())) {
						update.killed.push({ uid: enemy.getUid(), killer: annie.getUid() });
					} else {
						enemy.setStunnedTurn(game.getTurnNum() + 1);
						update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
						update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: annie.getUid() });
					}
				}

				annie.movedNum = game.getTurnNum();
				update.movedNum = annie.movedNum;
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
			name: 'Enchanted Crystal Arrow',
			description: 'Deals ' + Math.round(1.1 * this.dmg) + ' damage and stuns the target. Can target enemy in any lane.',
			type: AbilityType.GlobalEnemy,
			readyTurn: 0,
			effect: (game: Game, data: {sourceUid: string, targetUid?: string}, update: I.DataGameUpdate) => {
				let ashe = game.getChamp(data.sourceUid);
				let enemy = game.getChamp(data.targetUid);

				if (enemy.takeDamage(1.1 * ashe.getDamage(), ashe, game.getTurnNum())) {
					update.killed.push({ uid: enemy.getUid(), killer: ashe.getUid() });
				} else {
					enemy.setStunnedTurn(game.getTurnNum() + 1);
					update.affected.push({ uid: enemy.getUid(), status: I.Status.Stunned, turnNum: enemy.getStunnedTurn() });
					update.damaged.push({ uid: enemy.getUid(), health: enemy.getHealth(), attacker: ashe.getUid() });
				}

				ashe.movedNum = game.getTurnNum();
				update.movedNum = ashe.movedNum;
				return 6;
			}
		};
	}
}
championById[22] = Ashe;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//------------------------------------------------------------- B --------------------------------------------------------------------//
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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
				ally.setLocation(thresh.getLocation());

				update.moved = update.moved || [];

				update.moved.push({
					uid: ally.getUid(),
					location: ally.getLocation()
				});

				update.movedNum = game.getTurnNum();

				return 7;
			}
		};
	}
}
championById[412] = Thresh;


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

	public attackChamp(enemy: Champion, turnNum: number): boolean {
		let dmg = this.dmg;
		if (this.isBonusDamage) {
			dmg = Math.round(dmg * 1.15);
		}
		this.isBonusDamage = !this.isBonusDamage;

		return enemy.takeDamage(dmg, this, turnNum);
	}
}
championById[236] = Lucian;
