import { Module } from '@nestjs/common';
import { FxService } from './fx.service';
import { CurrencyMetadataService } from './currency-metadata.service';

@Module({
  providers: [FxService, CurrencyMetadataService],
  exports: [FxService, CurrencyMetadataService],
})
export class FxModule {}
