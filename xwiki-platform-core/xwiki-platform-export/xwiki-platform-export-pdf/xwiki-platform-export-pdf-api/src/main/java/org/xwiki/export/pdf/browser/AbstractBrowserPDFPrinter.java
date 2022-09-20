/*
 * See the NOTICE file distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as
 * published by the Free Software Foundation; either version 2.1 of
 * the License, or (at your option) any later version.
 *
 * This software is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this software; if not, write to the Free
 * Software Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA
 * 02110-1301 USA, or see the FSF site: http://www.fsf.org.
 */
package org.xwiki.export.pdf.browser;

import java.io.IOException;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

import javax.inject.Inject;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;

import org.apache.http.client.utils.URIBuilder;
import org.slf4j.Logger;
import org.xwiki.export.pdf.PDFExportConfiguration;
import org.xwiki.export.pdf.PDFPrinter;
import org.xwiki.stability.Unstable;

/**
 * Base class for {@link PDFPrinter} implementations that rely on a web browser to perform the PDF printing.
 * 
 * @version $Id$
 * @since 14.8
 */
@Unstable
public abstract class AbstractBrowserPDFPrinter implements PDFPrinter<URL>
{
    @Inject
    protected Logger logger;

    @Inject
    protected PDFExportConfiguration configuration;

    @Override
    public InputStream print(URL printPreviewURL) throws IOException
    {
        if (printPreviewURL == null) {
            throw new IOException("Print preview URL missing.");
        }
        this.logger.debug("Printing [{}]", printPreviewURL);

        BrowserTab browserTab = getBrowserManager().createIncognitoTab();
        URL browserPrintPreviewURL = getBrowserPrintPreviewURL(printPreviewURL, browserTab);
        try {
            Cookie[] cookies = getRequest().getCookies();
            if (!browserTab.navigate(browserPrintPreviewURL, cookies, true)) {
                throw new IOException("Failed to load the print preview URL: " + browserPrintPreviewURL);
            }

            if (!printPreviewURL.toString().equals(browserPrintPreviewURL.toString())) {
                // Make sure the relative URLs are resolved based on the original print preview URL otherwise the user
                // won't be able to open the links from the generated PDF because they use a host name accessible only
                // from the browser that generated the PDF. See PDFExportConfiguration#getXWikiHost()
                browserTab.setBaseURL(printPreviewURL);
            }

            return browserTab.printToPDF(() -> {
                browserTab.close();
            });
        } catch (Exception e) {
            // Close the browser tab only if an exception is caught. Otherwise the tab will be closed after the PDF
            // input stream is read and closed.
            browserTab.close();
            // Propagate the caught exception.
            throw e;
        }
    }

    /**
     * The given print preview URL was created based on the request made by the users's browser so it represents the way
     * the users's browser can access the print preview. The browser that we're using for PDF printing, that may be
     * running inside a dedicated Docker container, is not necessarily able to access the print preview in the same way,
     * because:
     * <ul>
     * <li>The user's browser may be behind some proxy or inside a different Docker container (with different settings)
     * like when running the functional tests, so the print preview URL suffers transformations before reaching XWiki,
     * transformations that don't happen for the web browser we're using for PDF printing.</li>
     * <li>For safety reasons the Docker container running the web browser uses its own separate network interface,
     * which means for it 'localhost' doesn't point to the host running XWiki, but the Docker container itself. See
     * {@link PDFExportConfiguration#getXWikiHost()}.</li>
     * </ul>
     * 
     * @param printPreviewURL the print preview URL used by the user's browser
     * @param browserTab browser tab that should be able to access the print preview URL
     * @return the print preview URL to be used by the browser performing the PDF printing
     * @throws IOException if building the print preview URL fails
     */
    private URL getBrowserPrintPreviewURL(URL printPreviewURL, BrowserTab browserTab) throws IOException
    {
        return getBrowserPrintPreviewURLs(printPreviewURL).stream()
            .filter(url -> this.isURLAccessibleFromBrowser(url, browserTab)).findFirst()
            .orElseThrow(() -> new IOException("Couldn't find an alternative print preview URL that the headless "
                + "Chrome web browser can access from within its Docker container."));
    }

    private List<URL> getBrowserPrintPreviewURLs(URL printPreviewURL) throws IOException
    {
        List<URL> browserPrintPreviewURLs = new ArrayList<>();

        // 1. Try first with the same URL as the user (this may work in a domain-based multi-wiki setup).
        browserPrintPreviewURLs.add(printPreviewURL);

        // 2. Try with the configured host.
        try {
            browserPrintPreviewURLs.add(
                new URIBuilder(printPreviewURL.toURI()).setHost(this.configuration.getXWikiHost()).build().toURL());
        } catch (URISyntaxException e) {
            throw new IOException(e);
        }

        return browserPrintPreviewURLs;
    }

    private boolean isURLAccessibleFromBrowser(URL printPreviewURL, BrowserTab browserTab)
    {
        try {
            URL restURL = new URL(printPreviewURL, getRequest().getContextPath() + "/rest");
            return browserTab.navigate(restURL);
        } catch (IOException e) {
            return false;
        }
    }

    @Override
    public boolean isAvailable()
    {
        try {
            return getBrowserManager().isConnected();
        } catch (Exception e) {
            this.logger.warn("Failed to connect to the web browser used for server-side PDF printing.", e);
            return false;
        }
    }

    /**
     * @return the browser manager used to interact with the browser used for PDF printing
     */
    protected abstract BrowserManager getBrowserManager();

    /**
     * @return the current HTTP servlet request, used to take the cookies from
     */
    protected abstract HttpServletRequest getRequest();
}
