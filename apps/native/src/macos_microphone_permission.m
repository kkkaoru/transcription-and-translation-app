#import <AVFoundation/AVFoundation.h>
#include <stdint.h>

typedef void (*KotobaMicrophonePermissionCallback)(uint8_t granted, void *context);

int32_t kotoba_microphone_authorization_status(void) {
    return (int32_t)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}

void kotoba_request_microphone_access(
    KotobaMicrophonePermissionCallback callback,
    void *context
) {
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
        callback(granted ? 1 : 0, context);
    }];
}
