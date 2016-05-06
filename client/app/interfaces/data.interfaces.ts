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

export interface ChampionData {
	champId: number;
	uid: string;
	champLevel: number;
	owner: string;
	health: number;
	maxHealth: number;
	dmg: number;
	currentLocation: Location;
	stunnedTurn: number;
	invulnTurn: number;
}

export interface DataGameError {
	errorCode: number;
	message: string;
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
	hand: ChampionData[];
	starter: string;
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
		targetLocation: Location;
	};

	/** Not yet implemented */
	ability?: {};
}

export interface DataGameUpdate {
	nexus?: {[playerId: string]: number};
	killed?: { uid: string, killer: string }[];
	damaged?: { uid: string, health: number, attacker: string }[];
	hand?: ChampionData[];
	enemySpawn?: ChampionData[];
	moved?: { uid: string, location: Location }[];

	turnNum: number;
	turnPlayer: string;
}
