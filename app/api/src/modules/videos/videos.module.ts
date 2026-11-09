import { Module } from '@nestjs/common';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { StationsModule } from '../stations/stations.module';
import { DerivativeController } from './derivative.controller';
import { DerivativeService } from './derivative.service';
import { DerivativeWorkerService } from './derivative-worker.service';
import { ChunkUploadService } from './chunk-upload.service';
import { VideoRetentionService } from './video-retention.service';
import { VideoRetentionController } from './video-retention.controller';
import { AlertModule } from '../../core/alert/alert.module';

@Module({
  // v3.55：视频归属判定需要工位可见性口径（关联工位可见 → 放行）
  // 源视频到期提醒复用 AlertMailerService（SMTP 通道），因此引入 AlertModule
  imports: [StationsModule, AlertModule],
  // SPEC-VID-P0 §4/§5/§7.1：派生端点 + 派生服务 + 5s 轮询 worker + 分片上传
  // 2026-11-06：源视频保留（到期提醒/硬删）服务与列表/操作端点
  controllers: [VideosController, DerivativeController, VideoRetentionController],
  providers: [
    VideosService, DerivativeService, DerivativeWorkerService, ChunkUploadService, VideoRetentionService,
  ],
  exports: [VideosService],
})
export class VideosModule {}
