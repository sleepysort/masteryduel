import g = require('./game');

export interface DataGameError {
	errorCode: number;
	reason?: string;
}

export interface DataGameJoin {
	gameId: string;
}

export interface DataGameJoinAck {
	success: boolean;
	playerId?: string;
	reason?: string;
}

export interface DataGamePrep {
	message?: string;
}

export interface DataGameSelect {
	playerId: string;
	summonerName: string;
}

export interface DataGameSelectAck {
	success: boolean;
	reason?: string;
}

export interface DataGameInit {
	hand: g.Champion[];
	starter: string;
	nexusHealth: number;
	playerIcon: number;
	enemyIcon: number;
	playerSummonerName: string;
	enemySummonerName: string;
}

export interface DataGameMove {
	/** Id of the player making the move */
	playerId: string;

	attackNexus?: {
		/** UID of the attacking champion */
		uid: string;
	};

	attackChamp?: {
		/** UID of the attacking champion */
		sourceUid: string;

		/** UID of the target champion */
		targetUid: string;
	};

	moveChamp?: {
		uid: string;
		targetLocation: g.Location;
	};

	ability?: {
		sourceUid: string;
		targetUid?: string;
	};
}

export interface DataGamePass {
	playerId: string;
}

export interface DataGameOver {
	victor: string;
}

export interface DataGameUpdate {
	sourceUid: string;
	nexus?: {[playerId: string]: number};
	killed?: { uid: string, killer: string }[];
	damaged?: { uid: string, health: number, attacker: string }[];
	hand?: g.Champion[];
	enemySpawn?: g.Champion[];
	moved?: { uid: string, location: g.Location }[];
	affected?: { uid: string, status: Status, turnNum: number }[];
	cooldown?: { uid: string, readyTurn: number }[];
	damageChange?: { uid: string, dmg: number }[];

	/** The turn number of the champion */
	movedNum?: number;

	turnNum: number;
	turnPlayer: string;
	moveCount: number;
}

/**
* Minimal champion data used for fountain and deck
*/
export interface ChampionMinData {
	summonerId: number;
	championId: number;
	championLevel: number;
}

export enum ChampionTag {
	Fighter,
	Mage,
	Assassin,
	Support,
	Marksman,
	Tank
}

export enum Status {
	None,
	Stunned,
	Invulnerable,
	Stasis,
	DamageReduction,
	Shielded,
	DamageBuff,
	Marked
}
