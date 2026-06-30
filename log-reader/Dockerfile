# syntax=docker/dockerfile:1

FROM nginx:alpine

COPY log-reader/nginx.conf /etc/nginx/conf.d/default.conf
COPY logs/reader.html /tmp/reader.html

# In Docker, log files live under /logs/ (mounted agent-logs volume).
RUN sed 's|const LOG_BASE = "./";|const LOG_BASE = "./logs/";|' /tmp/reader.html \
    > /usr/share/nginx/html/reader.html

EXPOSE 80
