import I = require('./interfaces');

export class StatComputer {

    public static getHealth(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number): number {
        return this.compStats(primary, secondary, champLevel, 'health');
    }

    public static getDamage(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number): number {
        return this.compStats(primary, secondary, champLevel, 'dmg');
    }

    private static getStatByTag(tag: I.ChampionTag, index: number): number {
        // baseHealth, healthScale, baseDmg, dmgScale
        var stats = [];
        if (tag === I.ChampionTag.Assassin) {
            stats = [30, 1.1, 9, 1.3];
        }
        else if (tag === I.ChampionTag.Fighter) {
            stats = [34, 1.2, 6, 1.3];
        }
        else if (tag === I.ChampionTag.Mage) {
            stats = [30, 1.2, 7, 1.25];
        }
        else if (tag === I.ChampionTag.Marksman) {
            stats = [30, 1.15, 8, 1.35];
        }
        else if (tag === I.ChampionTag.Support) {
            stats = [32, 1.2, 4, 1.2];
        }
        else if (tag === I.ChampionTag.Tank) {
            stats = [38, 1.3, 5, 1.2];
        }
        return stats[index];
    }

    private static compStats(primary: I.ChampionTag, secondary: I.ChampionTag, champLevel: number, stat: string): number {
        var index = 0;
        if (stat === 'dmg') {
            index += 2;
        }

        if (!secondary) {
            return Math.round(this.getStatByTag(primary, index) * Math.pow(this.getStatByTag(primary, index+1), champLevel));
            } else {
                return Math.round((this.getStatByTag(primary, index) * Math.pow(this.getStatByTag(primary, index+1), champLevel) +
                this.getStatByTag(secondary, index) * Math.pow(this.getStatByTag(secondary, index+1), champLevel)) / 2);
            }
        }
    }
