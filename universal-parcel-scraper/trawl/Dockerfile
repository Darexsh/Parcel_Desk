FROM python:3.12.15-slim-trixie@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704 AS zto-ocr
RUN python3 -m venv /opt/zto-ocr \
    && /opt/zto-ocr/bin/pip install --no-cache-dir numpy==2.5.4 pillow==13.0.0 onnxruntime==1.31.0 \
       opencv-python-headless==5.0.0.93 pyyaml==6.0.3 shapely==2.2.0 pyclipper==1.4.0 six==1.17.0 tqdm==4.70.1 \
    && /opt/zto-ocr/bin/pip install --no-cache-dir --no-deps ddddocr==1.6.1 rapidocr-onnxruntime==1.4.4

FROM ghcr.io/germondai/trawl:1.9.3@sha256:c46f74dfde3df278ff3dc5357f78df1109dfddd9aef754b4dcba1ac98f6fc6ae
LABEL org.opencontainers.image.source="https://github.com/plhery/universal-parcel-scraper" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
# TRAWL's request log includes the page path, where some carriers put the parcel number.
ENV LOG_LEVEL=warn
COPY --from=zto-ocr /usr/local /usr/local
COPY --from=zto-ocr /opt/zto-ocr /opt/zto-ocr
RUN /opt/zto-ocr/bin/python -c 'import ddddocr, rapidocr_onnxruntime, cv2'
COPY license.mjs /app/packages/tiers/src/utils/license.mjs
COPY tracking-capture.mjs /app/packages/tiers/src/utils/tracking-capture.mjs
COPY usps-tracking.mjs /app/packages/tiers/src/utils/usps-tracking.mjs
COPY swiftx-slider.mjs /app/packages/tiers/src/utils/swiftx-slider.mjs
COPY swiftx-slider.py /app/packages/tiers/src/utils/swiftx-slider.py
COPY royal-mail-history.mjs /app/packages/tiers/src/utils/royal-mail-history.mjs
COPY track123-browser.mjs /app/packages/tiers/src/utils/track123-browser.mjs
COPY fedex-session.mjs /app/packages/tiers/src/utils/fedex-session.mjs
COPY fedex-ipv6-proxy.mjs /app/packages/tiers/src/utils/fedex-ipv6-proxy.mjs
COPY fedex-ipv6-server.mjs /app/packages/tiers/src/utils/fedex-ipv6-server.mjs
COPY australia-post-browser.mjs /app/packages/tiers/src/utils/australia-post-browser.mjs
COPY wanbexpress-browser.mjs /app/packages/tiers/src/utils/wanbexpress-browser.mjs
COPY xpo-browser.mjs /app/packages/tiers/src/utils/xpo-browser.mjs
COPY magyar-posta-browser.mjs /app/packages/tiers/src/utils/magyar-posta-browser.mjs
COPY magyar-posta-app.mjs /app/packages/tiers/src/utils/magyar-posta-app.mjs
COPY jd-domestic-browser.mjs /app/packages/tiers/src/utils/jd-domestic-browser.mjs
COPY jd-icon.mjs /app/packages/tiers/src/utils/jd-icon.mjs
COPY jd-icon.py /app/packages/tiers/src/utils/jd-icon.py
COPY asendia-browser.mjs /app/packages/tiers/src/utils/asendia-browser.mjs
COPY correios-browser.mjs /app/packages/tiers/src/utils/correios-browser.mjs
COPY recaptcha-audio.mjs /app/packages/tiers/src/utils/recaptcha-audio.mjs
COPY recaptcha-backoff.mjs /app/packages/tiers/src/utils/recaptcha-backoff.mjs
COPY dhl-poland-native.mjs /app/packages/tiers/src/utils/dhl-poland-native.mjs
COPY dhl-poland-browser.mjs /app/packages/tiers/src/utils/dhl-poland-browser.mjs
COPY track718-juxi.mjs /app/packages/tiers/src/utils/track718-juxi.mjs
COPY ozon-browser.mjs /app/packages/tiers/src/utils/ozon-browser.mjs
COPY dhl-express-browser.mjs /app/packages/tiers/src/utils/dhl-express-browser.mjs
COPY poste-italiane-browser.mjs /app/packages/tiers/src/utils/poste-italiane-browser.mjs
COPY sf-express-session.mjs /app/packages/tiers/src/utils/sf-express-session.mjs
COPY sf-express-gap.mjs /app/packages/tiers/src/utils/sf-express-gap.mjs
COPY zto-browser.mjs /app/packages/tiers/src/utils/zto-browser.mjs
COPY zto-slider.mjs /app/packages/tiers/src/utils/zto-slider.mjs
COPY zto-ocr.mjs /app/packages/tiers/src/utils/zto-ocr.mjs
COPY zto-ocr.py /app/packages/tiers/src/utils/zto-ocr.py
COPY china-post-browser.mjs /app/packages/tiers/src/utils/china-post-browser.mjs
COPY china-post-ocr.mjs /app/packages/tiers/src/utils/china-post-ocr.mjs
COPY china-post-ocr.py /app/packages/tiers/src/utils/china-post-ocr.py
COPY tier-failure-log.mjs /app/apps/api/src/tier-failure-log.mjs
COPY install.mjs /tmp/install-tracking-capture.mjs
RUN bun /tmp/install-tracking-capture.mjs && rm /tmp/install-tracking-capture.mjs
