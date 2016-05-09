import path = require('path');

/************************************************
 * Path constants
 */
export const PROJ_ROOT: string = path.resolve(__dirname, '..');
export const PUBLIC_ROOT: string = path.resolve(PROJ_ROOT, 'public');
export const CLIENT_ROOT: string = path.resolve(PROJ_ROOT, 'client');
export const SERVER_ROOT: string = path.resolve(PROJ_ROOT, 'server');


export const LOL_API_URL: string = 'https://na.api.pvp.net';
export const LOL_API_KEY: string = 'api_key=c0e7cfb6-55b2-45f3-9ed6-f9eaacda4fb9';

export const MAX_PLAYERS: number = 2;
export const NEXUS_STARTING_HEALTH: number = 5;

export const TURN_TIMER = 75;
