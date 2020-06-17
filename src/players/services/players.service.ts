import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { Environment } from '@/environment/environment';
import { Player } from '../models/player';
import { DocumentType, ReturnModelType } from '@typegoose/typegoose';
import { SteamProfile } from '../models/steam-profile';
import { Etf2lProfileService } from './etf2l-profile.service';
import { InjectModel } from 'nestjs-typegoose';
import { GamesService } from '@/games/services/games.service';
import { PlayerStats } from '../models/player-stats';
import { Etf2lProfile } from '../models/etf2l-profile';
import { OnlinePlayersService } from './online-players.service';
import { SteamApiService } from './steam-api.service';
import { Subject } from 'rxjs';
import { TwitchTvUser } from '../models/twitch-tv-user';
import { DiscordService } from '@/discord/services/discord.service';
import { newPlayer, playerNameChanged } from '@/discord/notifications';
import { ObjectId } from 'mongodb';
import { minimumTf2InGameHours, requireEtf2lAccount } from '@configs/players';

@Injectable()
export class PlayersService {

  private logger = new Logger(PlayersService.name);
  private _playerRegistered = new Subject<string>();

  get playerRegistered() {
    return this._playerRegistered.asObservable();
  }

  constructor(
    private environment: Environment,
    private etf2lProfileService: Etf2lProfileService,
    @InjectModel(Player) private playerModel: ReturnModelType<typeof Player>,
    @Inject(forwardRef(() => GamesService)) private gamesService: GamesService,
    private onlinePlayersService: OnlinePlayersService,
    private steamApiService: SteamApiService,
    private discordService: DiscordService,
  ) { }

  async getAll(): Promise<DocumentType<Player>[]> {
    return await this.playerModel.find();
  }

  async getById(id: string | ObjectId): Promise<DocumentType<Player>> {
    return await this.playerModel.findById(id);
  }

  async findBySteamId(steamId: string) {
    return await this.playerModel.findOne({ steamId });
  }

  async findByEtf2lProfileId(etf2lProfileId: number) {
    return await this.playerModel.findOne({ etf2lProfileId });
  }

  async findByTwitchUserId(twitchTvUserId: string) {
    return await this.playerModel.findOne({ 'twitchTvUser.userId': twitchTvUserId });
  }

  async createPlayer(steamProfile: SteamProfile): Promise<DocumentType<Player>> {
    const hoursInTf2 = await this.steamApiService.getTf2InGameHours(steamProfile.id);
    if (hoursInTf2 < minimumTf2InGameHours) {
      throw new Error('not enough tf2 hours');
    }

    let etf2lProfile: Etf2lProfile;
    let name = steamProfile.displayName;

    try {
      etf2lProfile = await this.etf2lProfileService.fetchPlayerInfo(steamProfile.id);

      if (etf2lProfile.bans?.filter(ban => ban.end > Date.now() / 1000).length > 0) {
        throw new Error('this account is banned on ETF2L');
      }

      name = etf2lProfile.name;
    } catch (error) {
      if (requireEtf2lAccount) {
        throw error;
      }
    }

    const player = await this.playerModel.create({
      steamId: steamProfile.id,
      name,
      avatarUrl: steamProfile.photos[0].value,
      role: this.environment.superUser === steamProfile.id ? 'super-user' : null,
      etf2lProfileId: etf2lProfile?.id,
      hasAcceptedRules: false,
    });

    this.logger.verbose(`created new player (name: ${player?.name})`);
    this._playerRegistered.next(player.id);

    this.discordService.getAdminsChannel()?.send({
      embed: newPlayer({
        name: player.name,
        profileUrl: `${this.environment.clientUrl}/player/${player.id}`,
      }),
    });

    return player;
  }

  async registerTwitchAccount(playerId: string, twitchTvUser: TwitchTvUser) {
    const player = await this.getById(playerId);
    if (!player) {
      throw new Error('no such player');
    }

    player.twitchTvUser = twitchTvUser;
    await player.save();

    this.onlinePlayersService.getSocketsForPlayer(playerId).forEach(socket => {
      socket.emit('profile update', { twitchTvUser });
    });

    return player;
  }

  async getUsersWithTwitchTvAccount() {
    return await this.playerModel.find({ twitchTvUser: { $exists: true } });
  }

  async updatePlayer(playerId: string, update: Partial<Player>, adminId: string): Promise<DocumentType<Player>> {
    const admin = await this.getById(adminId);
    if (!admin)  {
      throw new Error('admin does not exist');
    }

    const player = await this.getById(playerId);
    if (player) {
      if (update.name) {
        const oldName = player.name;
        player.name = update.name;

        this.discordService.getAdminsChannel()?.send({
          embed: playerNameChanged({
            oldName,
            newName: player.name,
            profileUrl: `${this.environment.clientUrl}/player/${player.id}`,
            adminResponsible: admin.name,
          }),
        });
      }

      if (update.role !== undefined) {
        player.role = update.role;
      }

      await player.save();
      this.onlinePlayersService.getSocketsForPlayer(playerId).forEach(socket => socket.emit('profile update', { name: player.name }));

      return player;
    } else {
      return null;
    }
  }

  /**
   * Player accepts the rules.
   * Without accepting the rules, player cannot join the queue nor any game.
   */
  async acceptTerms(playerId: string): Promise<DocumentType<Player>> {
    const player = await this.getById(playerId);
    if (!player) {
      throw new Error('no such player');
    }

    player.hasAcceptedRules = true;
    await player.save();
    return player;
  }

  async getPlayerStats(playerId: string): Promise<PlayerStats> {
    const gamesPlayed = await this.gamesService.getPlayerGameCount(playerId, { endedOnly: true });
    const classesPlayed = await this.gamesService.getPlayerPlayedClassCount(playerId);
    return { player: playerId, gamesPlayed, classesPlayed };
  }

}
