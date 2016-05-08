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
	ability: Ability;
	currentLocation: Location;
	stunnedTurn: number;
	invulnTurn: number;
	movedNum: number;
}

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
	hand: ChampionData[];
	starter: string;
	nexusHealth: number;
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

	ability?: {
		sourceUid: string;
		targetUid?: string;
	};
}

export interface DataGameUpdate {
	sourceUid: string;
	nexus?: {[playerId: string]: number};
	killed?: { uid: string, killer: string }[];
	damaged?: { uid: string, health: number, attacker: string }[];
	hand?: ChampionData[];
	enemySpawn?: ChampionData[];
	moved?: { uid: string, location: Location }[];
	affected?: { uid: string, status: Status, turnNum: number }[];
	movedNum?: number;

	turnNum: number;
	turnPlayer: string;
	moveCount: number;
}

export interface DataGameChat {
	playerId: string;
	text: string;
}

/**
* Representation of a champion ability
*/
export interface Ability {
	readyTurn: number;  // cooldown; when game.turnNum >= readyTurn, ability can be used
	name: string;
	description: string;
	type: AbilityType
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
	Invulnerable
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
