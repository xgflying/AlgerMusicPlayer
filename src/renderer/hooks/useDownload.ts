import { cloneDeep } from 'lodash';
import { useMessage } from 'naive-ui';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { getSongUrl } from '@/store/modules/player';
import type { SongResult } from '@/types/music';
import { isElectron } from '@/utils';

const ipcRenderer = isElectron ? window.electron.ipcRenderer : null;

// 全局下载管理（闭包模式）
const createDownloadManager = () => {
  // 正在下载的文件集合
  const activeDownloads = new Set<string>();

  // 已经发送了通知的文件集合（避免重复通知）
  const notifiedDownloads = new Set<string>();

  // 事件监听器是否已初始化
  let isInitialized = false;

  // 监听器引用（用于清理）
  let completeListener: ((event: any, data: any) => void) | null = null;
  let errorListener: ((event: any, data: any) => void) | null = null;

  return {
    // 添加下载
    addDownload: (filename: string) => {
      activeDownloads.add(filename);
    },

    // 移除下载
    removeDownload: (filename: string) => {
      activeDownloads.delete(filename);
      // 延迟清理通知记录
      setTimeout(() => {
        notifiedDownloads.delete(filename);
      }, 5000);
    },

    // 标记文件已通知
    markNotified: (filename: string) => {
      notifiedDownloads.add(filename);
    },

    // 检查文件是否已通知
    isNotified: (filename: string) => {
      return notifiedDownloads.has(filename);
    },

    // 清理所有下载
    clearDownloads: () => {
      activeDownloads.clear();
      notifiedDownloads.clear();
    },

    // 初始化事件监听器
    initEventListeners: (message: any, t: any) => {
      if (isInitialized) return;

      // 移除可能存在的旧监听器
      if (completeListener) {
        ipcRenderer?.removeListener('music-download-complete', completeListener);
      }

      if (errorListener) {
        ipcRenderer?.removeListener('music-download-error', errorListener);
      }

      // 创建新的监听器
      completeListener = (_event, data) => {
        if (!data.filename || !activeDownloads.has(data.filename)) return;

        // 如果该文件已经通知过，则跳过
        if (notifiedDownloads.has(data.filename)) return;

        // 标记为已通知
        notifiedDownloads.add(data.filename);

        // 从活动下载移除
        activeDownloads.delete(data.filename);
      };

      errorListener = (_event, data) => {
        if (!data.filename || !activeDownloads.has(data.filename)) return;

        // 如果该文件已经通知过，则跳过
        if (notifiedDownloads.has(data.filename)) return;

        // 标记为已通知
        notifiedDownloads.add(data.filename);

        if (data.error === '该歌曲已下载' || data.error === '该歌曲已在下载队列中') {
          activeDownloads.delete(data.filename);
          return;
        }

        // 显示失败通知
        message.error(
          t('download.message.downloadFailed', {
            filename: data.filename,
            error: data.error || t('download.status.unknown')
          })
        );

        // 从活动下载移除
        activeDownloads.delete(data.filename);
      };

      // 添加监听器
      ipcRenderer?.on('music-download-complete', completeListener);
      ipcRenderer?.on('music-download-error', errorListener);

      isInitialized = true;
    },

    // 清理事件监听器
    cleanupEventListeners: () => {
      if (!isInitialized) return;

      if (completeListener) {
        ipcRenderer?.removeListener('music-download-complete', completeListener);
        completeListener = null;
      }

      if (errorListener) {
        ipcRenderer?.removeListener('music-download-error', errorListener);
        errorListener = null;
      }

      isInitialized = false;
    },

    // 获取活跃下载数量
    getActiveDownloadCount: () => {
      return activeDownloads.size;
    },

    // 检查是否有特定文件正在下载
    hasDownload: (filename: string) => {
      return activeDownloads.has(filename);
    }
  };
};

// 创建单例下载管理器
const downloadManager = createDownloadManager();

export const useDownload = () => {
  const { t } = useI18n();
  const message = useMessage();
  const isDownloading = ref(false);

  // 初始化事件监听器
  downloadManager.initEventListeners(message, t);

  const buildFilename = (song: SongResult) => {
    const artistNames = (song.ar || song.song?.artists)?.map((a) => a.name).join(',');
    return `${song.name} - ${artistNames}`;
  };

  const isSongDownloaded = async (songId: number | undefined) => {
    if (!ipcRenderer || !songId) return false;
    const result = await ipcRenderer.invoke('check-song-downloaded', songId);
    return !!result?.isDownloaded;
  };

  const enqueueDownload = async (song: SongResult) => {
    const musicUrl = (await getSongUrl(song.id as number, cloneDeep(song), true)) as any;
    if (!musicUrl) {
      throw new Error(t('songItem.message.getUrlFailed'));
    }

    const filename = buildFilename(song);

    if (downloadManager.hasDownload(filename)) {
      return;
    }

    downloadManager.addDownload(filename);

    const songData = cloneDeep(song);
    songData.ar = songData.ar || songData.song?.artists;

    ipcRenderer?.send('download-music', {
      url: typeof musicUrl === 'string' ? musicUrl : musicUrl.url,
      filename,
      songInfo: {
        ...songData,
        downloadTime: Date.now()
      },
      type: musicUrl.type
    });
  };

  /**
   * 下载单首音乐
   * @param song 歌曲信息
   * @returns Promise<void>
   */
  const downloadMusic = async (song: SongResult) => {
    try {
      await enqueueDownload(song);

      message.success(t('songItem.message.downloadQueued'));
    } catch (error: any) {
      console.error('Download error:', error);
      message.error(error.message || t('songItem.message.downloadFailed'));
    }
  };

  /**
   * 批量下载音乐
   * @param songs 歌曲列表
   * @returns Promise<void>
   */
  const batchDownloadMusic = async (songs: SongResult[]) => {
    if (songs.length === 0) {
      message.warning(t('favorite.selectSongsFirst'));
      return;
    }

    try {
      isDownloading.value = true;
      message.success(t('favorite.downloading'));

      let queuedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      const totalCount = songs.length;

      const songsToDownload: SongResult[] = [];
      for (const song of songs) {
        if (await isSongDownloaded(song.id as number)) {
          skippedCount++;
          continue;
        }
        songsToDownload.push(song);
      }

      // 并行获取所有歌曲的下载链接
      const downloadUrls = await Promise.all(
        songsToDownload.map(async (song) => {
          try {
            const data = (await getSongUrl(song.id, cloneDeep(song), true)) as any;
            return { song, ...data };
          } catch (error) {
            console.error(`获取歌曲 ${song.name} 下载链接失败:`, error);
            return { song, url: null };
          }
        })
      );

      // 开始下载有效的链接
      downloadUrls.forEach(({ song, url, type }) => {
        if (!url) {
          failedCount++;
          return;
        }

        const songData = cloneDeep(song);
        const filename = buildFilename(song);

        // 检查是否已在下载
        if (downloadManager.hasDownload(filename)) {
          skippedCount++;
          return;
        }

        // 添加到活动下载集合
        downloadManager.addDownload(filename);

        const songInfo = {
          ...songData,
          ar: songData.ar || songData.song?.artists,
          downloadTime: Date.now()
        };

        ipcRenderer?.send('download-music', {
          url,
          filename,
          songInfo,
          type
        });

        queuedCount++;
      });

      isDownloading.value = false;
      if (queuedCount > 0) {
        message.success(t('favorite.downloadSuccess'));
      } else if (skippedCount === totalCount) {
        message.info(t('favorite.downloadSuccess'));
      } else {
        message.error(t('favorite.downloadFailed'));
      }
    } catch (error) {
      console.error('下载失败:', error);
      isDownloading.value = false;
      message.destroyAll();
      message.error(t('favorite.downloadFailed'));
    }
  };

  /**
   * 下载播放列表全部音乐
   * @param songs 播放列表歌曲
   * @returns Promise<void>
   */
  const downloadPlayListAll = async (songs: SongResult[]) => {
    if (songs.length === 0) {
      message.info(t('player.playList.empty'));
      return;
    }

    try {
      isDownloading.value = true;

      const songsToDownload: SongResult[] = [];
      let skippedCount = 0;

      for (const song of songs) {
        if (await isSongDownloaded(song.id as number)) {
          skippedCount++;
          continue;
        }
        songsToDownload.push(song);
      }

      if (songsToDownload.length === 0) {
        isDownloading.value = false;
        message.info(t('player.playList.allDownloaded'));
        return;
      }

      const downloadUrls = await Promise.all(
        songsToDownload.map(async (song) => {
          try {
            const data = (await getSongUrl(song.id, cloneDeep(song), true)) as any;
            return { song, ...data };
          } catch (error) {
            console.error(`获取歌曲 ${song.name} 下载链接失败:`, error);
            return { song, url: null };
          }
        })
      );

      let queuedCount = 0;
      downloadUrls.forEach(({ song, url, type }) => {
        if (!url) return;

        const filename = buildFilename(song);
        if (downloadManager.hasDownload(filename)) return;

        downloadManager.addDownload(filename);

        const songData = cloneDeep(song);
        const songInfo = {
          ...songData,
          ar: songData.ar || songData.song?.artists,
          downloadTime: Date.now()
        };

        ipcRenderer?.send('download-music', {
          url,
          filename,
          songInfo,
          type
        });

        queuedCount++;
      });

      isDownloading.value = false;
      message.success(
        t('player.playList.downloadQueued', {
          count: queuedCount,
          skipped: skippedCount
        })
      );
    } catch (error: any) {
      console.error('下载失败:', error);
      isDownloading.value = false;
      message.error(error.message || t('favorite.downloadFailed'));
    }
  };

  return {
    isDownloading,
    downloadMusic,
    batchDownloadMusic,
    downloadPlayListAll
  };
};
