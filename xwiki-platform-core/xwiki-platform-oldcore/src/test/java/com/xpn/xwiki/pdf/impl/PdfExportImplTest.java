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
package com.xpn.xwiki.pdf.impl;

import org.junit.jupiter.api.Test;
import org.xwiki.bridge.DocumentAccessBridge;
import org.xwiki.environment.Environment;
import org.xwiki.model.reference.DocumentReferenceResolver;
import org.xwiki.model.reference.EntityReferenceSerializer;
import org.xwiki.test.annotation.ComponentList;
import org.xwiki.velocity.VelocityManager;

import com.xpn.xwiki.XWikiContext;
import com.xpn.xwiki.doc.XWikiDocument;
import com.xpn.xwiki.internal.pdf.XSLFORenderer;
import com.xpn.xwiki.test.MockitoOldcore;
import com.xpn.xwiki.test.junit5.mockito.InjectMockitoOldcore;
import com.xpn.xwiki.test.junit5.mockito.OldcoreTest;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit tests for {@link PdfExportImpl}.
 *
 * @version $Id$
 */
@ComponentList({
    org.xwiki.xml.internal.XMLReaderFactoryComponent.class,
})
@OldcoreTest
public class PdfExportImplTest
{
    @InjectMockitoOldcore
    private MockitoOldcore oldcore;

    /**
     * Verify that PDF Export can apply some CSS on the XHTML when that XHTML already has some style defined and in
     * shorthand notation.
     */
    @Test
    public void applyCSSWhenExistingStyleDefinedUsingShorthandNotation() throws Exception
    {
        this.oldcore.getMocker().registerMockComponent(DocumentReferenceResolver.TYPE_STRING, "currentmixed");
        this.oldcore.getMocker().registerMockComponent(EntityReferenceSerializer.TYPE_STRING);
        this.oldcore.getMocker().registerMockComponent(DocumentAccessBridge.class);
        this.oldcore.getMocker().registerMockComponent(DocumentAccessBridge.class);
        this.oldcore.getMocker().registerMockComponent(PDFResourceResolver.class);
        this.oldcore.getMocker().registerMockComponent(Environment.class);
        this.oldcore.getMocker().registerMockComponent(VelocityManager.class);
        this.oldcore.getMocker().registerMockComponent(XSLFORenderer.class, "fop");

        PdfExportImpl pdfExport = new PdfExportImpl();

        // The content below allows us to test several points:
        // 1) The SPAN below already has some style defined in shorthand notation( "background" is shorthand,
        //    see https://www.w3schools.com/css/css_background.asp). That's important for the test since that's what was
        //    failing in the past and why this test was written.
        // 2) We also test that HTML entities are correctly kept since we had issues with this at one point.
        String html = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            + "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" "
                + "\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">\n"
            + "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head>\n"
            + "<title>\n"
            + "  Main.ttt - ttt\n"
            + "</title>\n"
            + "<meta content=\"text/html; charset=UTF-8\" http-equiv=\"Content-Type\" />\n"
            + "<meta content=\"en\" name=\"language\" />\n"
            + "\n"
            + "</head><body class=\"exportbody\" id=\"body\" pdfcover=\"0\" pdftoc=\"0\">\n"
            + "\n"
            + "<div id=\"xwikimaincontainer\">\n"
            + "<div id=\"xwikimaincontainerinner\">\n"
            + "\n"
            + "<div id=\"xwikicontent\">\n"
            + "      <p><span style=\"background: white;\">Hello Cl&eacute;ment</span></p>\n"
            + "          </div>\n"
            + "</div>\n"
            + "</div>\n"
            + "\n"
            + "</body></html>";

        String css = "span { color:red; }";

        XWikiContext xcontext = this.oldcore.getXWikiContext();
        XWikiDocument doc = mock(XWikiDocument.class);
        when(doc.getExternalURL("view", xcontext)).thenReturn("http://localhost:8080/export");
        xcontext.setDoc(doc);

        // - Verify that element's style attributes are normalized and that the SPAN's color is set to red.
        // - Verify that the accent in the content is still there.
        //   TODO: right now we output the DOM with DOM4J and use the default of converting entities when using the
        //   XMLWriter. We need to decide if that's correct or if we should call XMLWriter#setResolveEntityRefs(false)
        //   instead.

        String expected = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            + "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" "
                + "\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\">"
                + "<html xmlns=\"http://www.w3.org/1999/xhtml\"><head>\n"
            + "<title>\n"
            + "  Main.ttt - ttt\n"
            + "</title>\n"
            + "<meta content=\"text/html; charset=UTF-8\" http-equiv=\"Content-Type\"/>\n"
            + "<meta content=\"en\" name=\"language\"/>\n\n"
            + "</head><body class=\"exportbody\" id=\"body\" pdfcover=\"0\" pdftoc=\"0\">\n\n"
            + "<div id=\"xwikimaincontainer\">\n"
            + "<div id=\"xwikimaincontainerinner\">\n\n"
            + "<div id=\"xwikicontent\">\n"
                + "      <p><span style=\"color: #f00; background-color: #fff; background-image: none; "
                + "background-position: 0% 0%; background-size: auto auto; background-origin: padding-box; "
                + "background-clip: border-box; background-repeat: repeat repeat; "
                + "background-attachment: scroll; \">Hello Clément</span></p>\n"
            + "          </div>\n"
            + "</div>\n"
            + "</div>\n\n"
            + "</body></html>";

        assertEquals(expected, pdfExport.applyCSS(html, css, xcontext));
    }
}
