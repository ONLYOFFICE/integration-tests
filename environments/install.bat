echo on

docker exec -it -u root a9024d129313 bash -c "java -jar /usr/local/tomcat/alfresco-mmt/alfresco-mmt-26.1.0.61.jar uninstall onlyoffice-integration-platform-jar /usr/local/tomcat/webapps/alfresco"
docker exec -it -u root a9024d129313 bash -c "java -jar /usr/local/tomcat/alfresco-mmt/alfresco-mmt-26.1.0.61.jar install /usr/local/tomcat/amps/onlyoffice-integration-repo.amp /usr/local/tomcat/webapps/alfresco -verbose -nobackup -force"
docker restart a9024d129313

docker exec -it -u root 10e19e07d904 bash -c "java -jar /usr/local/tomcat/alfresco-mmt/alfresco-mmt-26.1.0.61.jar uninstall onlyoffice-integration-share-jar /usr/local/tomcat/webapps/share"
docker exec -it -u root 10e19e07d904 bash -c "java -jar /usr/local/tomcat/alfresco-mmt/alfresco-mmt-26.1.0.61.jar install /usr/local/tomcat/amps_share/onlyoffice-integration-share.amp /usr/local/tomcat/webapps/share -verbose -nobackup -force"
docker restart 10e19e07d904
