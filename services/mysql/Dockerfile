# MySQL for the Den control plane. Railway's own MySQL template runs the
# stock image with a persistent volume at /var/lib/mysql; we do the same.
FROM mysql:8.4
EXPOSE 3306
CMD ["mysqld", "--innodb-use-native-aio=0", "--disable-log-bin", "--performance_schema=0", "--innodb-buffer-pool-size=256M"]
